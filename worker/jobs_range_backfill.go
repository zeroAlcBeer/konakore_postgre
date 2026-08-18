package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const rangeBackfillTaskID = "range-backfill"

// konachanComConfigured reports whether all credentials required to fetch the
// Cloudflare-protected konachan.com explicit source are present.
func (w *Worker) konachanComConfigured() bool {
	return w.cfg.KonachanLogin != "" &&
		w.cfg.KonachanPasswordHash != "" &&
		w.cfg.KonachanCFClearance != "" &&
		w.cfg.KonachanUserAgent != ""
}

// newKonachanComRequest builds an authenticated konachan.com post.json request
// that replays a browser cf_clearance cookie so Cloudflare lets it through.
func (w *Worker) newKonachanComRequest(ctx context.Context, tags string, limit int64) (*http.Request, error) {
	q := url.Values{}
	q.Set("limit", strconv.FormatInt(limit, 10))
	if tags != "" {
		q.Set("tags", tags)
	}
	if w.cfg.KonachanLogin != "" {
		q.Set("login", w.cfg.KonachanLogin)
	}
	if w.cfg.KonachanPasswordHash != "" {
		q.Set("password_hash", w.cfg.KonachanPasswordHash)
	}
	endpoint := strings.TrimRight(w.cfg.KonachanComBase, "/") + "/post.json?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", w.cfg.KonachanUserAgent)
	req.Header.Set("Cookie", "cf_clearance="+w.cfg.KonachanCFClearance)
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// fetchKonachanCom performs an authenticated GET and decodes the JSON post
// array. A non-200 status or an HTML body (Cloudflare challenge / expired
// clearance) is surfaced as an error so the caller can retry later.
func (w *Worker) fetchKonachanCom(ctx context.Context, tags string, limit int64) ([]map[string]any, error) {
	req, err := w.newKonachanComRequest(ctx, tags, limit)
	if err != nil {
		return nil, err
	}
	resp, err := w.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("konachan.com status %d (cf_clearance may be expired): %.120s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed[0] != '[' {
		return nil, fmt.Errorf("konachan.com returned non-JSON (cf_clearance may be expired): %.120s", trimmed)
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var posts []map[string]any
	if err := decoder.Decode(&posts); err != nil {
		return nil, err
	}
	return posts, nil
}

// runRangeBackfillScheduler walks id windows on konachan.com to recover the
// explicit/questionable posts that konachan.net no longer serves, then tails
// the newest window so freshly uploaded q/e posts keep flowing in.
func (w *Worker) runRangeBackfillScheduler(ctx context.Context) {
	def := taskDef(rangeBackfillTaskID)

	if !w.konachanComConfigured() {
		now := time.Now().UTC()
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "stopped", DesiredStatus: "stopped", ProgressPct: 0, Unit: "ids",
			State:  map[string]any{"current_step": "disabled", "reason": "missing_konachan_com_config"},
			Config: def.Config, CompletedAt: &now, LastRunAt: &now,
		})
		w.log.Warn("range backfill disabled: konachan.com credentials not configured",
			"event", "task_skip", "task", rangeBackfillTaskID, "reason", "missing_konachan_com_config")
		return
	}

	shortInterval := w.cfg.RangeBackfillInterval
	if shortInterval <= 0 {
		shortInterval = 2 * time.Minute
	}
	tailInterval := w.cfg.RangeBackfillTailInterval
	if tailInterval <= 0 {
		tailInterval = 15 * time.Minute
	}
	interval := shortInterval
	next := time.Now().UTC().Add(interval)
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "scheduled", DesiredStatus: "running", ProgressPct: 0, Unit: "ids",
		State:  map[string]any{"current_step": "waiting_for_next_run"},
		Config: def.Config, NextRunAt: &next,
	})
	w.log.Info("range backfill scheduler started", "event", "task_start",
		"interval", shortInterval.String(), "tail_interval", tailInterval.String(),
		"start_id", w.cfg.RangeBackfillStartID, "window", w.cfg.RangeBackfillWindow)

	for {
		if !sleepContext(ctx, time.Until(next)) {
			w.markTaskStopped(context.Background(), def, "running", "", "context_cancelled")
			return
		}
		caughtUp := w.runRangeBackfillOnce(ctx)
		// Once the historical gap is filled we only need to re-check as often as
		// a window's worth of new posts can appear, so switch to the longer tail
		// interval and stop probing every short tick.
		if caughtUp {
			interval = tailInterval
		} else {
			interval = shortInterval
		}
		next = time.Now().UTC().Add(interval)
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "scheduled", DesiredStatus: "running", ProgressPct: 100, Unit: "ids",
			State:  map[string]any{"current_step": "waiting_for_next_run", "caught_up": caughtUp},
			Config: def.Config, NextRunAt: &next,
		})
	}
}

func (w *Worker) runRangeBackfillOnce(ctx context.Context) (caughtUp bool) {
	def := taskDef(rangeBackfillTaskID)
	runID := runID()
	log := w.log.With("task", rangeBackfillTaskID, "run_id", runID)
	startedAt := time.Now().UTC()

	state, err := w.store.GetScheduleState(ctx, rangeBackfillTaskID)
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "load_schedule_state", err)
		return false
	}

	startID := w.cfg.RangeBackfillStartID
	window := w.cfg.RangeBackfillWindow
	if window <= 0 {
		window = 100
	}
	low := asInt64(state["current_id"])
	if low < startID {
		low = startID
	}

	// A single newest-first fetch doubles as the ceiling probe: posts[0].id is
	// the newest post id, and in tail mode this same response already contains
	// the trailing window, so no separate max-id request is needed.
	newest, err := w.fetchKonachanCom(ctx, "order:id_desc", window)
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "fetch_newest", err)
		return false
	}
	if len(newest) == 0 {
		w.markTaskError(ctx, def, "running", runID, "fetch_newest", fmt.Errorf("konachan.com returned no posts"))
		return false
	}
	ceiling := asInt64(newest[0]["id"])

	var posts []map[string]any
	var high, nextLow int64
	if low+window-1 >= ceiling {
		// Caught up: the newest-first fetch above already covers the tail window.
		caughtUp = true
		high = ceiling
		posts = newest
		nextLow = ceiling - window + 1
		if nextLow < startID {
			nextLow = startID
		}
	} else {
		// Still filling the historical gap: fetch the specific id window.
		caughtUp = false
		high = low + window - 1
		tags := fmt.Sprintf("id:%d..%d order:id_desc", low, high)
		posts, err = w.fetchKonachanCom(ctx, tags, window)
		if err != nil {
			w.markTaskError(ctx, def, "running", runID, "fetch_window", err)
			return false
		}
		nextLow = high + 1
	}

	progress := 0.0
	if ceiling > startID {
		progress = float64(low-startID) * 100 / float64(ceiling-startID)
		if progress > 100 {
			progress = 100
		}
	}
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "running", DesiredStatus: "running", ProgressPct: progress,
		CurrentValue: int64Ptr(low), TotalValue: int64Ptr(ceiling), Unit: "ids",
		State: map[string]any{
			"run_id": runID, "current_id": low, "window_low": low, "window_high": high,
			"ceiling": ceiling, "caught_up": caughtUp, "current_step": "fetching konachan.com window",
		},
		Config: def.Config, StartedAt: &startedAt, LastRunAt: &startedAt,
	})

	// An id-range query returns deleted posts too (unlike page-based browsing,
	// which hides them). Skip deleted / image-less posts so they don't clutter
	// the feed with the upstream "deleted" placeholder.
	active := make([]map[string]any, 0, len(posts))
	for _, p := range posts {
		if asString(p["status"]) == "deleted" || asString(p["file_url"]) == "" {
			continue
		}
		active = append(active, p)
	}
	skipped := len(posts) - len(active)
	if len(active) > 0 {
		if err := w.upsertPosts(ctx, active); err != nil {
			w.markTaskError(ctx, def, "running", runID, "upsert_window", err)
			return false
		}
	}

	state["current_id"] = float64(nextLow)
	state["last_low"] = float64(low)
	state["last_high"] = float64(high)
	state["last_count"] = float64(len(active))
	state["last_skipped_deleted"] = float64(skipped)
	state["ceiling"] = float64(ceiling)
	state["caught_up"] = caughtUp
	_ = w.store.UpdateScheduleState(ctx, rangeBackfillTaskID, state)

	completedAt := time.Now().UTC()
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "completed", DesiredStatus: "running", ProgressPct: progress,
		CurrentValue: int64Ptr(high), TotalValue: int64Ptr(ceiling), Unit: "ids",
		State: map[string]any{
			"run_id": runID, "current_id": nextLow, "window_low": low, "window_high": high,
			"last_count": len(active), "last_skipped_deleted": skipped, "ceiling": ceiling,
			"caught_up": caughtUp, "current_step": "completed",
		},
		Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
	})
	log.Info("range backfill window synced", "event", "batch_complete",
		"low", low, "high", high, "count", len(active), "skipped_deleted", skipped,
		"caught_up", caughtUp, "ceiling", ceiling)
	return caughtUp
}
