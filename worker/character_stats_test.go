package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

// Tag ids used by the fixtures. Definitions under test: docs/characters.md.
const (
	tagAlice   = 1
	tagBob     = 2
	tagCarol   = 3
	tagDave    = 4
	tagEve     = 5
	tagArtoria = 8 // artoria_pendragon_(all), excluded
	tagTagme   = 9 // tagme_(character), excluded
	tagWorkX   = 20
	tagWorkY   = 21
	tag2Girls  = 30
	tagSketch  = 31
)

type statsFixture struct {
	t    *testing.T
	db   *sql.DB
	tags map[int64]string
}

func newStatsFixture(t *testing.T) *statsFixture {
	f := &statsFixture{t: t, db: newTestDB(t), tags: map[int64]string{}}
	f.tag(tagAlice, "alice", 4)
	f.tag(tagBob, "bob", 4)
	f.tag(tagCarol, "carol", 4)
	f.tag(tagDave, "dave", 4)
	f.tag(tagEve, "eve", 4)
	f.tag(tagArtoria, "artoria_pendragon_(all)", 4)
	f.tag(tagTagme, "tagme_(character)", 4)
	f.tag(tagWorkX, "work_x", 3)
	f.tag(tagWorkY, "work_y", 3)
	f.tag(tag2Girls, "2girls", 0)
	f.tag(tagSketch, "sketch", 5)
	return f
}

func (f *statsFixture) tag(id int64, name string, typ int) {
	f.t.Helper()
	if _, err := f.db.Exec(
		`INSERT INTO tags (id, name, count, type, ambiguous) VALUES ($1, $2, 0, $3, FALSE)`,
		id, name, typ); err != nil {
		f.t.Fatal(err)
	}
	f.tags[id] = name
}

type fixturePost struct {
	id, parent int64
	rating     string // defaults to "s"
	score      int
	tags       []int64
}

func (f *statsFixture) post(p fixturePost) {
	f.t.Helper()
	if p.rating == "" {
		p.rating = "s"
	}
	names := make([]string, len(p.tags))
	for i, id := range p.tags {
		names[i] = f.tags[id]
	}
	raw := map[string]any{
		"id": p.id, "rating": p.rating, "score": p.score,
		"tags": strings.Join(names, " "), "width": 1920, "height": 1080,
	}
	if p.parent != 0 {
		raw["parent_id"] = p.parent
	}
	b, _ := json.Marshal(raw)
	if _, err := f.db.Exec(`INSERT INTO posts (id, raw_data) VALUES ($1, $2::jsonb)`, p.id, string(b)); err != nil {
		f.t.Fatal(err)
	}
	for _, tagID := range p.tags {
		if _, err := f.db.Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)`, p.id, tagID); err != nil {
			f.t.Fatal(err)
		}
	}
}

func (f *statsFixture) refresh() {
	f.t.Helper()
	ctx := context.Background()
	if _, err := f.db.ExecContext(ctx, `SELECT refresh_post_families()`); err != nil {
		f.t.Fatal(err)
	}
	if err := refreshMaterializedViews(ctx, f.db); err != nil {
		f.t.Fatal(err)
	}
}

type statsRow struct {
	familyCount int64
	work, cover sql.NullInt64
}

// stats returns character_stats keyed by tag id.
func (f *statsFixture) stats() map[int64]statsRow {
	f.t.Helper()
	rows, err := f.db.Query(`SELECT tag_id, family_count, work_tag_id, cover_post_id FROM character_stats`)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]statsRow{}
	for rows.Next() {
		var id int64
		var r statsRow
		if err := rows.Scan(&id, &r.familyCount, &r.work, &r.cover); err != nil {
			f.t.Fatal(err)
		}
		out[id] = r
	}
	if err := rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return out
}

// cooccurrence returns other_tag_id -> family_count for one character.
func (f *statsFixture) cooccurrence(tagID int64) map[int64]int64 {
	f.t.Helper()
	rows, err := f.db.Query(
		`SELECT other_tag_id, family_count FROM character_cooccurrence WHERE tag_id = $1`, tagID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var other, n int64
		if err := rows.Scan(&other, &n); err != nil {
			f.t.Fatal(err)
		}
		out[other] = n
	}
	if err := rows.Err(); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func TestCharacterStatsCountsFamiliesAndPicksWork(t *testing.T) {
	f := newStatsFixture(t)
	// alice: family {100, 101} and family {102}; work_x on both, work_y on one.
	f.post(fixturePost{id: 100, tags: []int64{tagAlice, tagWorkX}})
	f.post(fixturePost{id: 101, parent: 100, tags: []int64{tagAlice, tagWorkY}})
	f.post(fixturePost{id: 102, tags: []int64{tagAlice, tagWorkX}})
	// bob: one family each with work_y and work_x -> tie goes to the lower id.
	f.post(fixturePost{id: 110, tags: []int64{tagBob, tagWorkY}})
	f.post(fixturePost{id: 111, tags: []int64{tagBob, tagWorkX}})
	// carol: no copyright tag.
	f.post(fixturePost{id: 120, tags: []int64{tagCarol}})
	f.refresh()

	s := f.stats()
	if got := s[tagAlice].familyCount; got != 2 {
		t.Errorf("alice family_count = %d, want 2", got)
	}
	if got := s[tagAlice].work; got.Int64 != tagWorkX {
		t.Errorf("alice work = %v, want %d", got, tagWorkX)
	}
	if got := s[tagBob].work; got.Int64 != tagWorkX {
		t.Errorf("bob work = %v, want %d (tie -> lower id)", got, tagWorkX)
	}
	if got := s[tagCarol].work; got.Valid {
		t.Errorf("carol work = %v, want NULL", got)
	}
}

func TestCharacterStatsExcludesPlaceholderTags(t *testing.T) {
	f := newStatsFixture(t)
	f.post(fixturePost{id: 100, tags: []int64{tagAlice, tagTagme}})
	f.post(fixturePost{id: 101, tags: []int64{tagArtoria}})
	f.refresh()

	s := f.stats()
	for _, id := range []int64{tagTagme, tagArtoria} {
		if _, ok := s[id]; ok {
			t.Errorf("excluded tag %d has a character_stats row", id)
		}
	}
	if got := f.cooccurrence(tagAlice); len(got) != 0 {
		t.Errorf("alice co-occurrence = %v, want none (tagme is excluded)", got)
	}
	// An excluded tag does not make a post multi-character.
	if got := s[tagAlice].cover; got.Int64 != 100 {
		t.Errorf("alice cover = %v, want 100", got)
	}
}

func TestCharacterStatsCoverOrder(t *testing.T) {
	f := newStatsFixture(t)
	// Each loser beats the winner on score; the comment names the rule that
	// must rank it lower.
	f.post(fixturePost{id: 200, rating: "q", score: 999, tags: []int64{tagCarol}})          // not rated s
	f.post(fixturePost{id: 201, score: 500, tags: []int64{tagCarol, tagBob}})               // two characters
	f.post(fixturePost{id: 202, score: 400, tags: []int64{tagCarol, tag2Girls}})            // penalty tag
	f.post(fixturePost{id: 203, score: 300, tags: []int64{tagCarol, tagSketch}})            // penalty tag (style)
	f.post(fixturePost{id: 204, score: 10, tags: []int64{tagCarol}})                        // ties 205 on score, older id
	f.post(fixturePost{id: 205, score: 10, parent: 204, tags: []int64{tagCarol, tagWorkX}}) // winner
	f.post(fixturePost{id: 206, score: 5, tags: []int64{tagCarol}})                         // newest but lower score
	// dave has no s post.
	f.post(fixturePost{id: 210, rating: "e", score: 50, tags: []int64{tagDave}})
	f.refresh()

	s := f.stats()
	if got := s[tagCarol].cover; got.Int64 != 205 {
		t.Errorf("carol cover = %v, want 205", got)
	}
	if got := s[tagDave].cover; got.Valid {
		t.Errorf("dave cover = %v, want NULL", got)
	}
}

func TestCharacterCooccurrenceTopTenByFamily(t *testing.T) {
	f := newStatsFixture(t)
	// Partner 50+i appears with eve in i+1 families, so partner 50 (one
	// family) is the one cut by the top 10.
	id := int64(1000)
	for i := int64(0); i <= 10; i++ {
		partner := 50 + i
		f.tag(partner, "partner_"+string(rune('a'+i)), 4)
		for k := int64(0); k <= i; k++ {
			f.post(fixturePost{id: id, tags: []int64{tagEve, partner}})
			id++
		}
	}
	// A child post repeating a pair stays in its parent's family.
	f.post(fixturePost{id: id, parent: id - 1, tags: []int64{tagEve, 60}})
	f.refresh()

	got := f.cooccurrence(tagEve)
	if len(got) != 10 {
		t.Fatalf("eve co-occurrence has %d rows, want 10: %v", len(got), got)
	}
	if _, ok := got[50]; ok {
		t.Errorf("partner 50 (1 family) should be cut from the top 10")
	}
	if got[60] != 11 {
		t.Errorf("partner 60 family_count = %d, want 11", got[60])
	}
	if got := f.cooccurrence(51)[tagEve]; got != 2 {
		t.Errorf("partner 51 -> eve family_count = %d, want 2 (pairs count both ways)", got)
	}
}

func TestCharacterStatsRefreshPicksUpNewPosts(t *testing.T) {
	f := newStatsFixture(t)
	f.post(fixturePost{id: 100, tags: []int64{tagAlice}})
	f.refresh()
	f.post(fixturePost{id: 101, tags: []int64{tagAlice}})
	f.refresh()

	if got := f.stats()[tagAlice].familyCount; got != 2 {
		t.Errorf("alice family_count after second refresh = %d, want 2", got)
	}
}
