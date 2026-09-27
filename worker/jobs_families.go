package main

import (
	"context"
	"time"
)

// Post families (parent/child groups) live in post_derived. A trigger on
// posts keeps post_derived.parent_id current; the SQL function
// refresh_post_families() (migration 006) recomputes family_id and
// is_family_head from it. Writers of posts call markFamiliesDirty, and this
// loop coalesces those signals into at most one refresh per interval.

const (
	familiesTaskID          = "post-families"
	familiesRefreshInterval = time.Minute
)

func (w *Worker) markFamiliesDirty() {
	w.familiesDirty.Store(true)
}

func (w *Worker) runFamiliesRefresher(ctx context.Context) {
	def := taskDef(familiesTaskID)
	// Start dirty so writes made while the worker was down are picked up.
	w.markFamiliesDirty()
	for {
		if w.familiesDirty.Swap(false) {
			w.refreshFamiliesOnce(ctx, def)
		}
		if !sleepContext(ctx, familiesRefreshInterval) {
			w.markTaskStopped(context.Background(), def, "running", "", "context_cancelled")
			return
		}
	}
}

func (w *Worker) refreshFamiliesOnce(ctx context.Context, def TaskDefinition) {
	runID := runID()
	log := w.log.With("task", familiesTaskID, "run_id", runID)
	startedAt := time.Now().UTC()

	var changed int64
	if err := w.db.QueryRowContext(ctx, `SELECT refresh_post_families()`).Scan(&changed); err != nil {
		// Retry on the next tick; the error stays visible on the task.
		w.markFamiliesDirty()
		w.markTaskError(ctx, def, "running", runID, "refresh_post_families", err)
		return
	}

	completedAt := time.Now().UTC()
	durationMs := completedAt.Sub(startedAt).Milliseconds()
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "running", DesiredStatus: "running", ProgressPct: 100,
		State: map[string]any{
			"run_id": runID, "current_step": "waiting_for_changes",
			"last_changed_rows": changed, "last_duration_ms": durationMs,
		},
		Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
	})
	log.Info("post families refreshed", "event", "families_refreshed", "changed_rows", changed, "duration_ms", durationMs)
}
