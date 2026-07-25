package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"math"
	"time"
)

type TaskSnapshot struct {
	ID            string
	Name          string
	Type          string
	Category      string
	Status        string
	DesiredStatus string
	ProgressPct   float64
	CurrentValue  *int64
	TotalValue    *int64
	Unit          string
	State         map[string]any
	Config        map[string]any
	ErrorMessage  string
	StartedAt     *time.Time
	CompletedAt   *time.Time
	LastRunAt     *time.Time
	NextRunAt     *time.Time
}

type TaskDefinition struct {
	ID       string
	Name     string
	Type     string
	Category string
	Config   map[string]any
}

type TaskStore struct {
	db  *sql.DB
	log *slog.Logger
}

func NewTaskStore(db *sql.DB, logger *slog.Logger) *TaskStore {
	return &TaskStore{db: db, log: logger}
}

func (s *TaskStore) EnsureSchema(ctx context.Context) error {
	// Schema DDL lives in embedded migrations (see migrations.go); this
	// method only guarantees they ran and re-seeds idempotent defaults.
	if err := applyMigrations(ctx, s.db, s.log); err != nil {
		return err
	}

	defaultStates := map[string]map[string]any{
		"backfill-all": {"current_page": float64(1), "retries": float64(0), "is_active": true},
		"sync-recent":  {"current_page": float64(1), "retries": float64(0)},
		"sync-tags":    {"current_page": float64(1), "retries": float64(0), "is_active": true},
		"file-sync":    {"last_check": float64(0), "is_active": true},
	}
	for name, state := range defaultStates {
		raw, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO schedule_state (job_name, state)
			 VALUES ($1, $2::jsonb)
			 ON CONFLICT (job_name) DO NOTHING`,
			name, string(raw)); err != nil {
			return err
		}
	}

	return nil
}

func (s *TaskStore) SeedTask(ctx context.Context, def TaskDefinition, status, desired string) error {
	rawConfig, err := json.Marshal(def.Config)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO task_state (
			id, name, type, category, status, desired_status, progress_pct,
			state, config, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, 0, '{}'::jsonb, $7::jsonb, NOW())
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			type = EXCLUDED.type,
			category = EXCLUDED.category,
			status = EXCLUDED.status,
			desired_status = EXCLUDED.desired_status,
			error_message = NULL,
			config = EXCLUDED.config,
			updated_at = NOW()`,
		def.ID, def.Name, def.Type, def.Category, status, desired, string(rawConfig))
	return err
}

func (s *TaskStore) UpdateTask(ctx context.Context, snap TaskSnapshot) error {
	if snap.State == nil {
		snap.State = map[string]any{}
	}
	if snap.Config == nil {
		snap.Config = map[string]any{}
	}
	progress := math.Max(0, math.Min(100, snap.ProgressPct))
	rawState, err := json.Marshal(snap.State)
	if err != nil {
		return err
	}
	rawConfig, err := json.Marshal(snap.Config)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO task_state (
			id, name, type, category, status, desired_status, progress_pct,
			current_value, total_value, unit, state, config, error_message,
			started_at, completed_at, last_run_at, next_run_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''),
			$11::jsonb, $12::jsonb, NULLIF($13, ''), $14, $15, $16, $17, NOW())
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			type = EXCLUDED.type,
			category = EXCLUDED.category,
			status = EXCLUDED.status,
			desired_status = EXCLUDED.desired_status,
			progress_pct = EXCLUDED.progress_pct,
			current_value = EXCLUDED.current_value,
			total_value = EXCLUDED.total_value,
			unit = EXCLUDED.unit,
			state = EXCLUDED.state,
			config = EXCLUDED.config,
			error_message = EXCLUDED.error_message,
			started_at = EXCLUDED.started_at,
			completed_at = EXCLUDED.completed_at,
			last_run_at = EXCLUDED.last_run_at,
			next_run_at = EXCLUDED.next_run_at,
			updated_at = NOW()`,
		snap.ID, snap.Name, snap.Type, snap.Category, snap.Status, snap.DesiredStatus,
		progress, nullableInt64(snap.CurrentValue), nullableInt64(snap.TotalValue),
		snap.Unit, string(rawState), string(rawConfig), snap.ErrorMessage,
		nullableTime(snap.StartedAt), nullableTime(snap.CompletedAt),
		nullableTime(snap.LastRunAt), nullableTime(snap.NextRunAt))
	return err
}

func (s *TaskStore) GetScheduleState(ctx context.Context, jobName string) (map[string]any, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT state FROM schedule_state WHERE job_name = $1`, jobName).Scan(&raw)
	if err == sql.ErrNoRows {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	var state map[string]any
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, err
	}
	return state, nil
}

func (s *TaskStore) UpdateScheduleState(ctx context.Context, jobName string, state map[string]any) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO schedule_state (job_name, state, last_run_at)
		 VALUES ($1, $2::jsonb, NOW())
		 ON CONFLICT (job_name) DO UPDATE SET
			state = EXCLUDED.state,
			last_run_at = NOW()`,
		jobName, string(raw))
	return err
}

func nullableInt64(value *int64) sql.NullInt64 {
	if value == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *value, Valid: true}
}

func nullableTime(value *time.Time) sql.NullTime {
	if value == nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: *value, Valid: true}
}

func int64Ptr(value int64) *int64 {
	return &value
}
