package main

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Materialized views are refreshed on a fixed interval rather than on write
// signals: each refresh takes seconds and their readers tolerate the lag.
// Every view needs a unique index for REFRESH ... CONCURRENTLY.

const (
	matviewsTaskID          = "matviews"
	matviewsRefreshInterval = 10 * time.Minute
)

var matviews = []string{"stats_posts", "character_stats", "character_cooccurrence"}

func refreshMaterializedViews(ctx context.Context, db *sql.DB) error {
	for _, view := range matviews {
		if _, err := db.ExecContext(ctx, "REFRESH MATERIALIZED VIEW CONCURRENTLY "+view); err != nil {
			return fmt.Errorf("refresh %s: %w", view, err)
		}
	}
	return nil
}

func (w *Worker) runMatviewsRefresher(ctx context.Context) {
	def := taskDef(matviewsTaskID)
	for {
		w.refreshMatviewsOnce(ctx, def)
		if !sleepContext(ctx, matviewsRefreshInterval) {
			w.markTaskStopped(context.Background(), def, "running", "", "context_cancelled")
			return
		}
	}
}

func (w *Worker) refreshMatviewsOnce(ctx context.Context, def TaskDefinition) {
	runID := runID()
	startedAt := time.Now().UTC()
	if err := refreshMaterializedViews(ctx, w.db); err != nil {
		w.markTaskError(ctx, def, "running", runID, "refresh_materialized_views", err)
		return
	}
	completedAt := time.Now().UTC()
	durationMs := completedAt.Sub(startedAt).Milliseconds()
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "running", DesiredStatus: "running", ProgressPct: 100,
		State: map[string]any{
			"run_id": runID, "current_step": "waiting_for_interval", "last_duration_ms": durationMs,
		},
		Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
	})
	w.log.Info("materialized views refreshed", "task", matviewsTaskID, "run_id", runID,
		"event", "matviews_refreshed", "views", matviews, "duration_ms", durationMs)
}
