package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

func (w *Worker) runBackfill(ctx context.Context) {
	taskID := "backfill-all"
	def := taskDef(taskID)
	sleepContext(ctx, w.cfg.BackfillStartDelay)
	runID := runID()
	log := w.log.With("task", taskID, "run_id", runID)

	state, err := w.store.GetScheduleState(ctx, taskID)
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "load_schedule_state", err)
		return
	}
	if active, ok := state["is_active"]; ok && !asBool(active) {
		now := time.Now().UTC()
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "completed", DesiredStatus: "stopped", ProgressPct: 100,
			Unit: "pages", State: map[string]any{
				"run_id": runID, "current_page": asInt64(state["current_page"]), "current_step": "inactive",
			},
			Config: def.Config, CompletedAt: &now, LastRunAt: &now,
		})
		log.Info("backfill inactive, skipping", "event", "task_skip", "reason", "schedule_state_inactive")
		return
	}

	page := asInt64(state["current_page"])
	if page <= 0 {
		page = 1
	}
	interval := 10 * time.Second
	startedAt := time.Now().UTC()
	log.Info("backfill started", "event", "task_start", "page", page)

	for {
		select {
		case <-ctx.Done():
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		default:
		}

		now := time.Now().UTC()
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: 0,
			CurrentValue: int64Ptr(page), Unit: "pages",
			State: map[string]any{
				"run_id": runID, "current_page": page, "progress_kind": "indeterminate",
				"current_step": "fetching remote page",
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})

		count, err := w.syncPostsFromRemote(ctx, page, 100, log)
		if err != nil {
			log.Error("backfill page failed", "event", "task_error", "phase", "sync_posts", "page", page, "error", err)
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running", ProgressPct: 0,
				CurrentValue: int64Ptr(page), Unit: "pages",
				State: map[string]any{
					"run_id": runID, "current_page": page, "progress_kind": "indeterminate",
					"current_step": "retry_wait", "retry_delay_seconds": int(w.cfg.BackfillRetryDelay.Seconds()),
				},
				Config: def.Config, ErrorMessage: err.Error(), StartedAt: &startedAt, LastRunAt: &now,
			})
			if !sleepContext(ctx, w.cfg.BackfillRetryDelay) {
				w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
				return
			}
			continue
		}

		log.Info("backfill page synced", "event", "batch_complete", "page", page, "count", count)
		if count == 0 {
			completedAt := time.Now().UTC()
			state["is_active"] = false
			state["final_status"] = "completed"
			state["current_page"] = float64(page)
			_ = w.store.UpdateScheduleState(ctx, taskID, state)
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "completed", DesiredStatus: "stopped", ProgressPct: 100,
				CurrentValue: int64Ptr(page), Unit: "pages",
				State: map[string]any{
					"run_id": runID, "current_page": page, "last_page_count": 0, "current_step": "completed",
				},
				Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
			})
			log.Info("backfill completed", "event", "task_complete", "page", page)
			return
		}

		state["current_page"] = float64(page + 1)
		state["interval_seconds"] = int(interval.Seconds())
		state["is_active"] = true
		_ = w.store.UpdateScheduleState(ctx, taskID, state)
		page++
		now = time.Now().UTC()
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: 0,
			CurrentValue: int64Ptr(page), Unit: "pages",
			State: map[string]any{
				"run_id": runID, "current_page": page, "last_page_count": count,
				"progress_kind": "indeterminate", "current_step": "cooldown",
				"next_delay_seconds": int(interval.Seconds()),
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})
		if !sleepContext(ctx, interval) {
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		}
		interval *= 2
		if interval > w.cfg.BackfillMaxBackoff {
			interval = w.cfg.BackfillMaxBackoff
		}
	}
}

func (w *Worker) runRecentScheduler(ctx context.Context) {
	taskID := "sync-recent"
	def := taskDef(taskID)
	next := time.Now().UTC().Add(w.cfg.RecentInterval)
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "scheduled", DesiredStatus: "running", ProgressPct: 100,
		CurrentValue: int64Ptr(1), TotalValue: int64Ptr(1), Unit: "runs",
		State:  map[string]any{"current_step": "waiting_for_next_run"},
		Config: def.Config, NextRunAt: &next,
	})
	for {
		if !sleepContext(ctx, time.Until(next)) {
			w.markTaskStopped(context.Background(), def, "running", "", "context_cancelled")
			return
		}
		w.runRecentOnce(ctx)
		next = time.Now().UTC().Add(w.cfg.RecentInterval)
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "scheduled", DesiredStatus: "running", ProgressPct: 100,
			CurrentValue: int64Ptr(1), TotalValue: int64Ptr(1), Unit: "runs",
			State:  map[string]any{"current_step": "waiting_for_next_run"},
			Config: def.Config, NextRunAt: &next,
		})
	}
}

func (w *Worker) runRecentOnce(ctx context.Context) {
	taskID := "sync-recent"
	def := taskDef(taskID)
	runID := runID()
	log := w.log.With("task", taskID, "run_id", runID)
	startedAt := time.Now().UTC()
	// Always fetch page 1 (newest 100 posts). With ~27 new posts/day and a
	// 3h interval, page 1 covers the last 3-4 days — enough to capture new
	// posts and refresh metadata during the maturity window. Older posts'
	// score/fav/comment changes are not tracked.
	const page int64 = 1
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "running", DesiredStatus: "running", ProgressPct: 0,
		CurrentValue: int64Ptr(0), TotalValue: int64Ptr(1), Unit: "pages",
		State:  map[string]any{"run_id": runID, "current_page": page, "current_step": "fetching remote page"},
		Config: def.Config, StartedAt: &startedAt, LastRunAt: &startedAt,
	})
	count, err := w.syncPostsFromRemote(ctx, page, 100, log)
	completedAt := time.Now().UTC()
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "sync_posts", err)
		return
	}
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "completed", DesiredStatus: "running", ProgressPct: 100,
		CurrentValue: int64Ptr(1), TotalValue: int64Ptr(1), Unit: "pages",
		State:  map[string]any{"run_id": runID, "current_page": page, "last_page_count": count, "current_step": "completed"},
		Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
	})
	log.Info("recent sync completed", "event", "task_complete", "page", page, "count", count)
}

func (w *Worker) syncPostsFromRemote(ctx context.Context, page, limit int64, logger *slog.Logger) (int, error) {
	url := fmt.Sprintf("https://konachan.net/post.json?page=%d&limit=%d", page, limit)
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := w.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("remote status %d", resp.StatusCode)
	}
	decoder := json.NewDecoder(resp.Body)
	decoder.UseNumber()
	var posts []map[string]any
	if err := decoder.Decode(&posts); err != nil {
		return 0, err
	}
	if len(posts) == 0 {
		return 0, nil
	}

	if err := w.upsertPosts(ctx, posts); err != nil {
		return 0, err
	}
	logger.Info("remote posts synced", "event", "remote_sync_complete", "page", page, "count", len(posts), "duration_ms", time.Since(start).Milliseconds())
	return len(posts), nil
}

// upsertPosts writes a batch of raw konachan post objects into the posts table
// in a single transaction, marking each row for reprocessing.
func (w *Worker) upsertPosts(ctx context.Context, posts []map[string]any) error {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, post := range posts {
		id := asInt64(post["id"])
		if id == 0 {
			continue
		}
		raw, err := json.Marshal(post)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO posts (id, raw_data, last_synced_at)
			 VALUES ($1, $2::jsonb, NOW())
			 ON CONFLICT (id) DO UPDATE SET
				raw_data = EXCLUDED.raw_data,
				last_synced_at = NOW(),
				is_processed = CASE
					WHEN posts.raw_data IS DISTINCT FROM EXCLUDED.raw_data THEN FALSE
					ELSE posts.is_processed
				END`,
			id, string(raw)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	w.markFamiliesDirty()
	return nil
}
