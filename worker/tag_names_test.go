package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
)

func tagNamesGz(t *testing.T, revision string, names map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if err := json.NewEncoder(w).Encode(tagNamesData{Source: "test", Revision: revision, Names: names}); err != nil {
		t.Fatal(err)
	}
	w.Close()
	return buf.Bytes()
}

func TestEmbeddedTagNamesLoad(t *testing.T) {
	data, err := loadTagNames(tagNamesZhGz)
	if err != nil {
		t.Fatal(err)
	}
	if data.Names["1girl"] == "" || data.Names["flowers"] == "" {
		t.Fatalf("embedded data lacks a known tag or alias: %q %q", data.Names["1girl"], data.Names["flowers"])
	}
}

func TestImportTagNames(t *testing.T) {
	ctx := context.Background()
	db := newTestDB(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	names := func() map[string]string {
		rows, err := db.QueryContext(ctx, `SELECT name, zh FROM tag_names_zh`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]string{}
		for rows.Next() {
			var name, zh string
			if err := rows.Scan(&name, &zh); err != nil {
				t.Fatal(err)
			}
			got[name] = zh
		}
		return got
	}

	if err := importTagNames(ctx, db, log, tagNamesGz(t, "r1", map[string]string{"a": "甲", "b": "乙"})); err != nil {
		t.Fatal(err)
	}
	if got := names(); len(got) != 2 || got["a"] != "甲" {
		t.Fatalf("after r1: %v", got)
	}

	// Same revision: left alone, even if the table was changed meanwhile.
	if _, err := db.ExecContext(ctx, `DELETE FROM tag_names_zh WHERE name = 'b'`); err != nil {
		t.Fatal(err)
	}
	if err := importTagNames(ctx, db, log, tagNamesGz(t, "r1", map[string]string{"a": "甲", "b": "乙"})); err != nil {
		t.Fatal(err)
	}
	if got := names(); len(got) != 1 {
		t.Fatalf("same revision re-imported: %v", got)
	}

	// New revision replaces every row.
	if err := importTagNames(ctx, db, log, tagNamesGz(t, "r2", map[string]string{"c": "丙"})); err != nil {
		t.Fatal(err)
	}
	if got := names(); len(got) != 1 || got["c"] != "丙" {
		t.Fatalf("after r2: %v", got)
	}
	var revision string
	if err := db.QueryRowContext(ctx, `SELECT revision FROM tag_names_zh_revision`).Scan(&revision); err != nil || revision != "r2" {
		t.Fatalf("revision = %q, %v", revision, err)
	}
}
