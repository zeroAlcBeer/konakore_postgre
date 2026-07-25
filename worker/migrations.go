package main

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"sort"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// legacyBaseline lists the migrations that existed before schema_migrations
// tracking was introduced. A database that already has the posts table but
// no recorded versions predates the tracker and is assumed to have them
// applied (they are not idempotent, so re-running would fail).
var legacyBaseline = []string{
	"001_initial_schema.sql",
	"002_task_state.sql",
	"003_pgvector.sql",
}

func applyMigrations(ctx context.Context, db *sql.DB, log *slog.Logger) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	if len(applied) == 0 {
		var postsExists bool
		if err := db.QueryRowContext(ctx,
			`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'posts')`,
		).Scan(&postsExists); err != nil {
			return fmt.Errorf("check legacy schema: %w", err)
		}
		if postsExists {
			for _, version := range legacyBaseline {
				if _, err := db.ExecContext(ctx,
					`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
					version); err != nil {
					return fmt.Errorf("baseline %s: %w", version, err)
				}
				applied[version] = true
			}
			log.Info("baselined legacy schema", "event", "migrations_baselined", "versions", len(legacyBaseline))
		}
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		if applied[name] {
			continue
		}
		content, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(content)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			tx.Rollback()
			return fmt.Errorf("record %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
		log.Info("applied migration", "event", "migration_applied", "version", name)
	}
	return nil
}
