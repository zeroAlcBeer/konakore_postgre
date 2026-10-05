package main

import (
	"context"
	"database/sql"
	"testing"
)

func insertRatedPost(t *testing.T, db *sql.DB, id int64, rating string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO posts (id, raw_data) VALUES ($1, jsonb_build_object('id', $1::bigint, 'rating', $2::text))`,
		id, rating); err != nil {
		t.Fatal(err)
	}
}

func statsPostRatings(t *testing.T, db *sql.DB) map[int64]string {
	t.Helper()
	rows, err := db.Query(`SELECT post_id, rating FROM stats_posts`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var rating string
		if err := rows.Scan(&id, &rating); err != nil {
			t.Fatal(err)
		}
		out[id] = rating
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRefreshMaterializedViewsUpdatesStatsPosts(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	insertRatedPost(t, db, 1, "s")
	if err := refreshMaterializedViews(ctx, db); err != nil {
		t.Fatal(err)
	}
	insertRatedPost(t, db, 2, "e")
	if _, err := db.Exec(`UPDATE posts SET raw_data = jsonb_set(raw_data, '{rating}', '"q"') WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := refreshMaterializedViews(ctx, db); err != nil {
		t.Fatal(err)
	}

	got := statsPostRatings(t, db)
	want := map[int64]string{1: "q", 2: "e"}
	if len(got) != len(want) || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("stats_posts = %v, want %v", got, want)
	}
}
