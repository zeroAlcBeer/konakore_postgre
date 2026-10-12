package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/lib/pq"
)

// Built by scripts/build_tag_names.py; rules in docs/tag-names.md.
//
//go:embed assets/tag_names_zh.json.gz
var tagNamesZhGz []byte

type tagNamesData struct {
	Source   string            `json:"source"`
	Revision string            `json:"revision"`
	Names    map[string]string `json:"names"`
}

func loadTagNames(gz []byte) (tagNamesData, error) {
	var data tagNamesData
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return data, err
	}
	defer r.Close()
	if err := json.NewDecoder(r).Decode(&data); err != nil {
		return data, err
	}
	if data.Revision == "" || len(data.Names) == 0 {
		return data, errors.New("tag names data has no revision or no names")
	}
	return data, nil
}

// importTagNames replaces tag_names_zh with gz (tagNamesZhGz in production)
// when the revision it holds differs; otherwise it does nothing.
func importTagNames(ctx context.Context, db *sql.DB, log *slog.Logger, gz []byte) error {
	data, err := loadTagNames(gz)
	if err != nil {
		return fmt.Errorf("load tag names: %w", err)
	}

	var current string
	err = db.QueryRowContext(ctx, `SELECT revision FROM tag_names_zh_revision`).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read tag names revision: %w", err)
	}
	if current == data.Revision {
		return nil
	}

	names := make([]string, 0, len(data.Names))
	zhs := make([]string, 0, len(data.Names))
	for name, zh := range data.Names {
		names = append(names, name)
		zhs = append(zhs, zh)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range []struct {
		query string
		args  []any
	}{
		{`DELETE FROM tag_names_zh`, nil},
		{`INSERT INTO tag_names_zh (name, zh) SELECT * FROM unnest($1::text[], $2::text[])`,
			[]any{pq.Array(names), pq.Array(zhs)}},
		{`DELETE FROM tag_names_zh_revision`, nil},
		{`INSERT INTO tag_names_zh_revision (revision) VALUES ($1)`, []any{data.Revision}},
	} {
		if _, err := tx.ExecContext(ctx, stmt.query, stmt.args...); err != nil {
			return fmt.Errorf("import tag names: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tag names: %w", err)
	}
	log.Info("imported tag names", "event", "tag_names_imported",
		"source", data.Source, "revision", data.Revision, "previous", current, "names", len(names))
	return nil
}
