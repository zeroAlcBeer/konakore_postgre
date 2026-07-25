-- Migration 002: Worker task state and progress

CREATE TABLE IF NOT EXISTS task_state (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'stopped',
    desired_status TEXT NOT NULL DEFAULT 'stopped',
    progress_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    current_value BIGINT,
    total_value BIGINT,
    unit TEXT,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_state_status ON task_state(status);
CREATE INDEX IF NOT EXISTS idx_task_state_updated_at ON task_state(updated_at);
