package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	embeddingsTaskID        = "embeddings"
	embeddingsRebuildTaskID = "embeddings-rebuild"
	embeddingDim            = 32000
	embeddingMinTagCount    = 10
	embeddingBatchSize      = 100
)

// typeWeightsCosine are sqrt-scaled relative to the legacy TF-IDF weights;
// cosine similarity squares the contribution in the dot product, so moderate
// values here yield ~equivalent practical impact.
var typeWeightsCosine = map[int]float64{
	0: 0.6, // GENERAL
	1: 1.7, // ARTIST
	3: 1.4, // COPYRIGHT
	4: 1.2, // CHARACTER
	5: 0.3, // META
	6: 1.2, // COMPANY
}

type vocabEntry struct {
	Dim        int
	Idf        float64
	TypeWeight float64
}

type Vocabulary struct {
	mu       sync.RWMutex
	byTagID  map[int64]vocabEntry
	dimCount int
}

func (v *Vocabulary) lookup(tagID int64) (vocabEntry, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	e, ok := v.byTagID[tagID]
	return e, ok
}

func (v *Vocabulary) size() int {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return len(v.byTagID)
}

func (w *Worker) loadVocabulary(ctx context.Context) (*Vocabulary, error) {
	vocab := &Vocabulary{byTagID: make(map[int64]vocabEntry)}

	rows, err := w.db.QueryContext(ctx,
		`SELECT tag_id, dim, idf, type_weight FROM tag_vocabulary WHERE is_active = TRUE`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var tagID int64
		var dim int
		var idf, tw float64
		if err := rows.Scan(&tagID, &dim, &idf, &tw); err != nil {
			rows.Close()
			return nil, err
		}
		vocab.byTagID[tagID] = vocabEntry{Dim: dim, Idf: idf, TypeWeight: tw}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	err = w.db.QueryRowContext(ctx,
		`SELECT dim_count FROM tag_vocabulary_meta WHERE id = 1`).Scan(&vocab.dimCount)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	return vocab, nil
}

// sparsevec text format helpers ------------------------------------------------

type sparseEntry struct {
	Index int // 1-based, matching pgvector convention
	Value float64
}

func formatSparseVec(entries []sparseEntry, dim int) string {
	if len(entries) == 0 {
		return fmt.Sprintf("{}/%d", dim)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Index < entries[j].Index })
	var b strings.Builder
	b.WriteByte('{')
	for i, e := range entries {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Itoa(e.Index))
		b.WriteByte(':')
		b.WriteString(strconv.FormatFloat(e.Value, 'g', -1, 64))
	}
	b.WriteByte('}')
	b.WriteByte('/')
	b.WriteString(strconv.Itoa(dim))
	return b.String()
}

func parseSparseVec(s string) ([]sparseEntry, int, error) {
	slash := strings.LastIndexByte(s, '/')
	if slash < 0 {
		return nil, 0, fmt.Errorf("invalid sparsevec: %q", s)
	}
	dim, err := strconv.Atoi(strings.TrimSpace(s[slash+1:]))
	if err != nil {
		return nil, 0, err
	}
	body := strings.TrimSpace(s[:slash])
	if !strings.HasPrefix(body, "{") || !strings.HasSuffix(body, "}") {
		return nil, 0, fmt.Errorf("invalid sparsevec body: %q", body)
	}
	body = body[1 : len(body)-1]
	if strings.TrimSpace(body) == "" {
		return nil, dim, nil
	}
	parts := strings.Split(body, ",")
	entries := make([]sparseEntry, 0, len(parts))
	for _, p := range parts {
		colon := strings.IndexByte(p, ':')
		if colon < 0 {
			return nil, 0, fmt.Errorf("invalid pair: %q", p)
		}
		idx, err := strconv.Atoi(strings.TrimSpace(p[:colon]))
		if err != nil {
			return nil, 0, err
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(p[colon+1:]), 64)
		if err != nil {
			return nil, 0, err
		}
		entries = append(entries, sparseEntry{Index: idx, Value: v})
	}
	return entries, dim, nil
}

func normalizeSparse(entries []sparseEntry) []sparseEntry {
	var sum float64
	for _, e := range entries {
		sum += e.Value * e.Value
	}
	if sum == 0 {
		return entries
	}
	norm := math.Sqrt(sum)
	out := make([]sparseEntry, len(entries))
	for i, e := range entries {
		out[i] = sparseEntry{Index: e.Index, Value: e.Value / norm}
	}
	return out
}

// per-post computation --------------------------------------------------------

func (w *Worker) computePostEmbedding(ctx context.Context, postID int64, vocab *Vocabulary) (string, error) {
	rows, err := w.db.QueryContext(ctx,
		`SELECT tag_id FROM post_tags WHERE post_id = $1`, postID)
	if err != nil {
		return "", err
	}
	entries := make([]sparseEntry, 0, 16)
	for rows.Next() {
		var tagID int64
		if err := rows.Scan(&tagID); err != nil {
			rows.Close()
			return "", err
		}
		entry, ok := vocab.lookup(tagID)
		if !ok {
			continue
		}
		entries = append(entries, sparseEntry{
			Index: entry.Dim + 1,
			Value: entry.Idf * entry.TypeWeight,
		})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(entries) == 0 {
		// Post has no embeddable tags. Store empty sparsevec to skip future
		// retries; similarity to any profile will be 0.
		return formatSparseVec(nil, embeddingDim), nil
	}
	entries = normalizeSparse(entries)
	return formatSparseVec(entries, embeddingDim), nil
}

func (w *Worker) countUnembedded(ctx context.Context) (int64, error) {
	var n int64
	err := w.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM post_derived WHERE is_processed AND tag_embedding IS NULL`).Scan(&n)
	return n, err
}

func (w *Worker) embedPostsBatch(ctx context.Context, log *slog.Logger, vocab *Vocabulary, limit int) (int, error) {
	rows, err := w.db.QueryContext(ctx,
		`SELECT post_id FROM post_derived
		 WHERE is_processed AND tag_embedding IS NULL
		 ORDER BY post_id LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}

	updated := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			return updated, ctx.Err()
		}
		lit, err := w.computePostEmbedding(ctx, id, vocab)
		if err != nil {
			log.Warn("compute embedding failed", "event", "embed_compute_failed", "post_id", id, "error", err)
			continue
		}
		if _, err := w.db.ExecContext(ctx,
			`UPDATE post_derived SET tag_embedding = $1::sparsevec WHERE post_id = $2`, lit, id); err != nil {
			log.Warn("update embedding failed", "event", "embed_update_failed", "post_id", id, "error", err)
			continue
		}
		updated++
	}
	return updated, nil
}

// continuous worker -----------------------------------------------------------

func (w *Worker) runEmbeddings(ctx context.Context) {
	def := taskDef(embeddingsTaskID)
	rid := runID()
	log := w.log.With("task", def.ID, "run_id", rid)
	startedAt := time.Now().UTC()
	idle := 0
	processedTotal := int64(0)

	vocab, err := w.loadVocabulary(ctx)
	if err != nil {
		w.markTaskError(ctx, def, "running", rid, "load_vocabulary", err)
		return
	}

	for {
		select {
		case <-ctx.Done():
			w.markTaskStopped(context.Background(), def, "running", rid, "context_cancelled")
			return
		default:
		}

		if vocab.size() == 0 {
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running",
				State:  map[string]any{"run_id": rid, "current_step": "vocab_empty"},
				Config: def.Config, StartedAt: &startedAt,
			})
			log.Info("vocabulary empty, awaiting rebuild", "event", "vocab_empty")
			if !sleepContext(ctx, 60*time.Second) {
				w.markTaskStopped(context.Background(), def, "running", rid, "context_cancelled")
				return
			}
			vocab, err = w.loadVocabulary(ctx)
			if err != nil {
				w.markTaskError(ctx, def, "running", rid, "reload_vocabulary", err)
				return
			}
			continue
		}

		remaining, err := w.countUnembedded(ctx)
		if err != nil {
			w.markTaskError(ctx, def, "running", rid, "count_unembedded", err)
			return
		}
		processed, err := w.embedPostsBatch(ctx, log, vocab, embeddingBatchSize)
		if err != nil {
			w.markTaskError(ctx, def, "running", rid, "embed_batch", err)
			return
		}
		processedTotal += int64(processed)
		now := time.Now().UTC()
		total := processedTotal + remaining
		if remaining == 0 {
			total = processedTotal
		}

		if processed > 0 {
			idle = 0
			log.Info("embeddings batch processed", "event", "batch_complete", "processed", processed, "remaining", remaining)
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running", ProgressPct: percent(processedTotal, total),
				CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(total), Unit: "posts",
				State: map[string]any{
					"run_id": rid, "current_step": "embedding",
					"last_batch_processed": processed, "remaining_count": remaining,
				},
				Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
			})
			if !sleepContext(ctx, 1*time.Second) {
				w.markTaskStopped(context.Background(), def, "running", rid, "context_cancelled")
				return
			}
			continue
		}

		idle++
		sleep := time.Duration(30*(1<<min(idle, 7))) * time.Second
		if sleep > time.Hour {
			sleep = time.Hour
		}
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: 100,
			CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(processedTotal), Unit: "posts",
			State: map[string]any{
				"run_id": rid, "current_step": "idle_wait",
				"idle_count": idle, "sleep_seconds": int(sleep.Seconds()),
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})
		log.Info("embeddings idle", "event", "idle_wait", "idle_count", idle, "sleep_seconds", int(sleep.Seconds()))
		if !sleepContext(ctx, sleep) {
			w.markTaskStopped(context.Background(), def, "running", rid, "context_cancelled")
			return
		}
		// Reload vocab in case a rebuild ran while we were idle.
		if refreshed, err := w.loadVocabulary(ctx); err == nil {
			vocab = refreshed
		} else {
			log.Warn("reload vocabulary failed", "event", "vocab_reload_failed", "error", err)
		}
	}
}

// full rebuild (one-shot, triggered via HTTP) ---------------------------------

func (w *Worker) runEmbeddingsRebuild(ctx context.Context) error {
	def := taskDef(embeddingsRebuildTaskID)
	rid := runID()
	log := w.log.With("task", def.ID, "run_id", rid)
	startedAt := time.Now().UTC()

	markStep := func(step string, current, total int64) {
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running",
			ProgressPct:  percent(current, total),
			CurrentValue: int64Ptr(current), TotalValue: int64Ptr(total), Unit: "posts",
			State:  map[string]any{"run_id": rid, "current_step": step},
			Config: def.Config, StartedAt: &startedAt,
		})
	}

	markStep("vocabulary", 0, 0)
	log.Info("rebuilding vocabulary", "event", "vocab_rebuild_start")
	newDimsAdded, deactivated, err := w.rebuildVocabulary(ctx)
	if err != nil {
		w.markTaskError(ctx, def, "stopped", rid, "rebuild_vocabulary", err)
		return err
	}
	log.Info("vocabulary rebuilt", "event", "vocab_rebuild_done",
		"new_dims", newDimsAdded, "deactivated", deactivated)

	vocab, err := w.loadVocabulary(ctx)
	if err != nil {
		w.markTaskError(ctx, def, "stopped", rid, "load_vocabulary", err)
		return err
	}

	var total int64
	if err := w.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM post_derived WHERE is_processed`).Scan(&total); err != nil {
		w.markTaskError(ctx, def, "stopped", rid, "count_posts", err)
		return err
	}

	rows, err := w.db.QueryContext(ctx,
		`SELECT post_id FROM post_derived WHERE is_processed ORDER BY post_id`)
	if err != nil {
		w.markTaskError(ctx, def, "stopped", rid, "select_posts", err)
		return err
	}
	var allIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			w.markTaskError(ctx, def, "stopped", rid, "scan_posts", err)
			return err
		}
		allIDs = append(allIDs, id)
	}
	rows.Close()

	var done int64
	for _, id := range allIDs {
		if ctx.Err() != nil {
			w.markTaskStopped(ctx, def, "stopped", rid, "context_cancelled")
			return ctx.Err()
		}
		lit, err := w.computePostEmbedding(ctx, id, vocab)
		if err != nil {
			log.Warn("compute failed", "event", "embed_compute_failed", "post_id", id, "error", err)
			continue
		}
		if _, err := w.db.ExecContext(ctx,
			`UPDATE post_derived SET tag_embedding = $1::sparsevec WHERE post_id = $2`, lit, id); err != nil {
			log.Warn("update failed", "event", "embed_update_failed", "post_id", id, "error", err)
			continue
		}
		done++
		if done%500 == 0 {
			markStep("embeddings", done, total)
		}
	}

	markStep("user_profile", total, total)
	log.Info("rebuilding user profile", "event", "profile_rebuild_start")
	if err := w.rebuildUserProfile(ctx); err != nil {
		w.markTaskError(ctx, def, "stopped", rid, "rebuild_profile", err)
		return err
	}

	completedAt := time.Now().UTC()
	_ = w.store.UpdateTask(ctx, TaskSnapshot{
		ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
		Status: "completed", DesiredStatus: "stopped",
		ProgressPct:  100,
		CurrentValue: int64Ptr(done), TotalValue: int64Ptr(total), Unit: "posts",
		State: map[string]any{
			"run_id": rid, "current_step": "completed",
			"new_dims_added":   newDimsAdded,
			"deactivated_dims": deactivated,
			"embeddings_done":  done,
		},
		Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
	})
	log.Info("embeddings rebuild complete", "event", "rebuild_complete",
		"duration_sec", time.Since(startedAt).Seconds(), "embeddings", done)
	return nil
}

// rebuildVocabulary: monotonic dim allocation. New tags get appended dims;
// existing tags refresh their idf/type_weight; tags that no longer qualify
// are marked is_active=false but keep their dim slot.
func (w *Worker) rebuildVocabulary(ctx context.Context) (newAdded, deactivated int, err error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	var totalPosts int64
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM posts`).Scan(&totalPosts); err != nil {
		return 0, 0, err
	}
	if totalPosts == 0 {
		return 0, 0, fmt.Errorf("vocabulary rebuild aborted: no posts in DB")
	}

	var dimCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT dim_count FROM tag_vocabulary_meta WHERE id = 1`).Scan(&dimCount); err != nil {
		return 0, 0, err
	}

	existing := make(map[int64]int)
	rows, err := tx.QueryContext(ctx, `SELECT tag_id, dim FROM tag_vocabulary`)
	if err != nil {
		return 0, 0, err
	}
	for rows.Next() {
		var tagID int64
		var dim int
		if err := rows.Scan(&tagID, &dim); err != nil {
			rows.Close()
			return 0, 0, err
		}
		existing[tagID] = dim
	}
	rows.Close()

	type qualTag struct {
		Count   int64
		TagType int
	}
	qualifying := make(map[int64]qualTag)
	qrows, err := tx.QueryContext(ctx, `
		SELECT id, count, type FROM tags
		WHERE count >= $1 AND name NOT LIKE 'tagme%'
		ORDER BY id`, embeddingMinTagCount)
	if err != nil {
		return 0, 0, err
	}
	for qrows.Next() {
		var id int64
		var cnt int64
		var tt int
		if err := qrows.Scan(&id, &cnt, &tt); err != nil {
			qrows.Close()
			return 0, 0, err
		}
		qualifying[id] = qualTag{Count: cnt, TagType: tt}
	}
	qrows.Close()

	weightFor := func(tt int) float64 {
		if v, ok := typeWeightsCosine[tt]; ok {
			return v
		}
		return 1.0
	}

	// Pass 1: append new tags with monotonic dims.
	var newTagIDs []int64
	for tagID := range qualifying {
		if _, ok := existing[tagID]; !ok {
			newTagIDs = append(newTagIDs, tagID)
		}
	}
	sort.Slice(newTagIDs, func(i, j int) bool { return newTagIDs[i] < newTagIDs[j] })

	if dimCount+len(newTagIDs) > embeddingDim {
		return 0, 0, fmt.Errorf("vocabulary would exceed sparsevec column dim %d (current=%d, new=%d)",
			embeddingDim, dimCount, len(newTagIDs))
	}

	nextDim := dimCount
	for _, tagID := range newTagIDs {
		q := qualifying[tagID]
		idf := math.Log(float64(totalPosts) / math.Max(float64(q.Count), 1))
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO tag_vocabulary (dim, tag_id, idf, type_weight, is_active, updated_at)
			 VALUES ($1, $2, $3, $4, TRUE, NOW())`,
			nextDim, tagID, idf, weightFor(q.TagType)); err != nil {
			return 0, 0, err
		}
		nextDim++
	}
	newAdded = nextDim - dimCount

	// Pass 2: refresh existing rows; mark inactive ones that requalified as active.
	for tagID, q := range qualifying {
		if _, ok := existing[tagID]; !ok {
			continue
		}
		idf := math.Log(float64(totalPosts) / math.Max(float64(q.Count), 1))
		if _, err := tx.ExecContext(ctx,
			`UPDATE tag_vocabulary
			 SET idf = $1, type_weight = $2, is_active = TRUE, updated_at = NOW()
			 WHERE tag_id = $3`,
			idf, weightFor(q.TagType), tagID); err != nil {
			return 0, 0, err
		}
	}

	// Pass 3: deactivate tags that no longer qualify.
	if _, err := tx.ExecContext(ctx,
		`UPDATE tag_vocabulary tv
		 SET is_active = FALSE, updated_at = NOW()
		 WHERE is_active = TRUE
		   AND NOT EXISTS (
			SELECT 1 FROM tags t
			WHERE t.id = tv.tag_id
			  AND t.count >= $1
			  AND t.name NOT LIKE 'tagme%'
		   )`,
		embeddingMinTagCount); err != nil {
		return 0, 0, err
	}

	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tag_vocabulary WHERE is_active = FALSE`).Scan(&deactivated); err != nil {
		return 0, 0, err
	}

	var activeCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tag_vocabulary WHERE is_active = TRUE`).Scan(&activeCount); err != nil {
		return 0, 0, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE tag_vocabulary_meta
		 SET dim_count = $1, active_count = $2, total_posts = $3, updated_at = NOW()
		 WHERE id = 1`,
		nextDim, activeCount, totalPosts); err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return newAdded, deactivated, nil
}

// rebuildUserProfile computes user_profile from scratch as the L2-normalized
// mean of all liked posts' embeddings. Called by both the rebuild task and
// the like/unlike HTTP endpoint — full recompute avoids floating-point drift.
func (w *Worker) rebuildUserProfile(ctx context.Context) error {
	rows, err := w.db.QueryContext(ctx,
		`SELECT d.tag_embedding::text
		 FROM post_likes l
		 JOIN post_derived d ON d.post_id = l.post_id
		 WHERE d.tag_embedding IS NOT NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()

	sum := make(map[int]float64)
	count := 0
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return err
		}
		entries, _, err := parseSparseVec(s)
		if err != nil {
			return err
		}
		for _, e := range entries {
			sum[e.Index] += e.Value
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if count == 0 {
		_, err := w.db.ExecContext(ctx,
			`UPDATE user_profile SET embedding = NULL, liked_count = 0, updated_at = NOW() WHERE id = 1`)
		return err
	}

	entries := make([]sparseEntry, 0, len(sum))
	inv := 1.0 / float64(count)
	for idx, v := range sum {
		entries = append(entries, sparseEntry{Index: idx, Value: v * inv})
	}
	entries = normalizeSparse(entries)
	lit := formatSparseVec(entries, embeddingDim)

	_, err = w.db.ExecContext(ctx,
		`UPDATE user_profile
		 SET embedding = $1::sparsevec, liked_count = $2, updated_at = NOW()
		 WHERE id = 1`, lit, count)
	return err
}

// updateUserProfileForLike is invoked by the API on every like/unlike.
// If the post has no embedding yet, the profile cannot change — defer until
// the continuous worker fills it in (no-op here, returns nil).
func (w *Worker) updateUserProfileForLike(ctx context.Context, postID int64) error {
	var hasEmbedding bool
	err := w.db.QueryRowContext(ctx,
		`SELECT tag_embedding IS NOT NULL FROM post_derived WHERE post_id = $1`, postID).Scan(&hasEmbedding)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if !hasEmbedding {
		return nil
	}
	return w.rebuildUserProfile(ctx)
}
