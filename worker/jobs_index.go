package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lib/pq"
)

const (
	postTagsScheduleKey = "post-tags"
	tagAPISpacing       = 200 * time.Millisecond
)

func (w *Worker) runPostTags(ctx context.Context) {
	taskID := "post-tags"
	def := taskDef(taskID)
	runID := runID()
	log := w.log.With("task", taskID, "run_id", runID)
	startedAt := time.Now().UTC()
	processedTotal := int64(0)
	idle := 0

	for {
		select {
		case <-ctx.Done():
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		default:
		}

		remaining, err := w.countUnprocessedPosts(ctx)
		if err != nil {
			w.markTaskError(ctx, def, "running", runID, "count_unprocessed_posts", err)
			return
		}
		total := processedTotal + remaining
		current := processedTotal
		if remaining == 0 {
			current = total
		}

		processed, candidates, err := w.processPostTagsBatch(ctx, log, w.cfg.PostTagsBatchSize)
		if err != nil {
			w.markTaskError(ctx, def, "running", runID, "process_post_tags_batch", err)
			return
		}
		processedTotal += int64(processed)
		now := time.Now().UTC()
		if processed > 0 {
			idle = 0
			log.Info("post-tags batch processed", "event", "batch_complete", "processed", processed, "candidates", candidates, "remaining", remaining)
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running", ProgressPct: percent(processedTotal, total),
				CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(total), Unit: "posts",
				State: map[string]any{
					"run_id": runID, "current_step": "processing",
					"last_batch_processed": processed, "last_batch_candidates": candidates,
					"remaining_count": remaining,
				},
				Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
			})
			if !sleepContext(ctx, 2*time.Second) {
				w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
				return
			}
			continue
		}

		idle++
		sleep := time.Duration(30*(1<<min(idle, 7))) * time.Second
		if sleep > time.Hour {
			sleep = time.Hour
		}
		progress := 100.0
		if total > 0 && current < total {
			progress = percent(current, total)
		}
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: progress,
			CurrentValue: int64Ptr(current), TotalValue: int64Ptr(total), Unit: "posts",
			State: map[string]any{
				"run_id": runID, "current_step": "idle_wait",
				"idle_count": idle, "sleep_seconds": int(sleep.Seconds()),
				"remaining_count": remaining, "last_batch_candidates": candidates,
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})
		log.Info("post-tags idle", "event", "idle_wait", "idle_count", idle, "sleep_seconds", int(sleep.Seconds()), "remaining", remaining)
		if !sleepContext(ctx, sleep) {
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		}
	}
}

func (w *Worker) countUnprocessedPosts(ctx context.Context) (int64, error) {
	var count int64
	err := w.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM post_derived WHERE NOT is_processed`).Scan(&count)
	return count, err
}

func (w *Worker) processPostTagsBatch(ctx context.Context, log *slog.Logger, limit int) (processedCount int, candidateCount int, err error) {
	type postRow struct {
		ID  int64
		Raw map[string]any
	}
	rows, err := w.db.QueryContext(ctx,
		`SELECT p.id, p.raw_data
		 FROM post_derived d
		 JOIN posts p ON p.id = d.post_id
		 WHERE NOT d.is_processed
		 ORDER BY d.post_id LIMIT $1`, limit)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	var posts []postRow
	globalNames := make([]string, 0)
	seen := map[string]bool{}
	for rows.Next() {
		var id int64
		var rawBytes []byte
		if err := rows.Scan(&id, &rawBytes); err != nil {
			return 0, 0, err
		}
		raw := decodeJSON(rawBytes)
		posts = append(posts, postRow{ID: id, Raw: raw})
		tags := stringsFromTags(raw)
		for _, name := range tags {
			if !seen[name] {
				seen[name] = true
				globalNames = append(globalNames, name)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if len(posts) == 0 || len(globalNames) == 0 {
		return 0, len(posts), nil
	}

	tagRows, err := w.db.QueryContext(ctx,
		`SELECT id, name FROM tags WHERE name = ANY($1)`, pq.Array(globalNames))
	if err != nil {
		return 0, len(posts), err
	}
	defer tagRows.Close()

	nameToID := map[string]int64{}
	for tagRows.Next() {
		var id int64
		var name string
		if err := tagRows.Scan(&id, &name); err != nil {
			return 0, len(posts), err
		}
		nameToID[name] = id
	}
	if err := tagRows.Err(); err != nil {
		return 0, len(posts), err
	}

	unresolvable, err := w.resolveMissingTagsViaAPI(ctx, log, globalNames, nameToID)
	if err != nil {
		log.Warn("missing-tag api resolver returned error, partial results retained",
			"event", "tag_resolver_error", "error", err)
	}
	if unresolvable == nil {
		unresolvable = map[string]bool{}
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, len(posts), err
	}
	defer tx.Rollback()

	for _, post := range posts {
		tags := stringsFromTags(post.Raw)
		if len(tags) == 0 {
			continue
		}

		knownTagIDs := make([]int64, 0, len(tags))
		skippedNames := make([]string, 0)
		canIndex := true
		for _, name := range tags {
			if id, ok := nameToID[name]; ok {
				knownTagIDs = append(knownTagIDs, id)
				continue
			}
			if unresolvable[name] {
				skippedNames = append(skippedNames, name)
				continue
			}
			// missing locally and not on the unresolvable list — likely transient
			// (api error / not yet attempted). Skip this post; retry next cycle.
			canIndex = false
			break
		}
		if !canIndex {
			continue
		}

		for _, tagID := range knownTagIDs {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO post_tags (post_id, tag_id, created_at)
				 VALUES ($1, $2, NOW())
				 ON CONFLICT (post_id, tag_id) DO NOTHING`,
				post.ID, tagID); err != nil {
				return 0, len(posts), err
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE post_derived SET is_processed = TRUE WHERE post_id = $1`, post.ID); err != nil {
			return 0, len(posts), err
		}
		if len(skippedNames) > 0 {
			log.Info("post indexed best-effort, unresolvable tags skipped",
				"event", "post_best_effort_indexed",
				"post_id", post.ID, "skipped_tag_names", skippedNames)
		}
		processedCount++
	}
	if err := tx.Commit(); err != nil {
		return 0, len(posts), err
	}
	return processedCount, len(posts), nil
}

func stringsFromTags(raw map[string]any) []string {
	tagString := asString(raw["tags"])
	if tagString == "" {
		tagString = asString(raw["tag_string"])
	}
	return strings.Fields(tagString)
}

func (w *Worker) runLikesMigration(ctx context.Context) {
	taskID := "likes-migration"
	def := taskDef(taskID)
	runID := runID()
	log := w.log.With("task", taskID, "run_id", runID)
	startedAt := time.Now().UTC()

	exists, err := tableExists(ctx, w.db, "likes")
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "check_likes_table", err)
		return
	}
	if !exists {
		now := time.Now().UTC()
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "completed", DesiredStatus: "stopped", ProgressPct: 100,
			CurrentValue: int64Ptr(0), TotalValue: int64Ptr(0), Unit: "likes",
			State:  map[string]any{"run_id": runID, "current_step": "skipped", "reason": "likes_table_missing"},
			Config: def.Config, StartedAt: &startedAt, CompletedAt: &now, LastRunAt: &now,
		})
		log.Info("likes migration skipped", "event", "task_skip", "reason", "likes_table_missing")
		return
	}

	total, err := w.countLegacyLikes(ctx)
	if err != nil {
		w.markTaskError(ctx, def, "running", runID, "count_legacy_likes", err)
		return
	}
	processedTotal := int64(0)
	idle := 0

	for {
		select {
		case <-ctx.Done():
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		default:
		}

		processed, err := w.processLikesBatch(ctx, w.cfg.LikesBatchSize)
		if err != nil {
			w.markTaskError(ctx, def, "running", runID, "process_likes_batch", err)
			return
		}
		now := time.Now().UTC()
		if processed > 0 {
			processedTotal += int64(processed)
			idle = 0
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running", ProgressPct: percent(processedTotal, total),
				CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(total), Unit: "likes",
				State:  map[string]any{"run_id": runID, "current_step": "processing", "last_batch_processed": processed},
				Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
			})
			log.Info("likes batch processed", "event", "batch_complete", "processed", processed, "processed_total", processedTotal, "total", total)
			w.fileSync.Start("likes_migration_batch")
			if !sleepContext(ctx, 2*time.Second) {
				w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
				return
			}
			continue
		}

		resolved, deletedOrphans, orphanErr := w.processOrphanLikesBatch(ctx, log, w.cfg.LikesBatchSize)
		if orphanErr != nil {
			log.Warn("orphan resolver batch failed, will retry next cycle", "event", "orphan_batch_error", "error", orphanErr)
		}
		if resolved+deletedOrphans > 0 {
			processedTotal += int64(resolved + deletedOrphans)
			if processedTotal > total {
				total = processedTotal
			}
			idle = 0
			now = time.Now().UTC()
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "running", DesiredStatus: "running", ProgressPct: percent(processedTotal, total),
				CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(total), Unit: "likes",
				State: map[string]any{
					"run_id":                runID,
					"current_step":          "resolving_orphans",
					"last_orphans_resolved": resolved,
					"last_orphans_deleted":  deletedOrphans,
				},
				Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
			})
			log.Info("orphan likes batch processed", "event", "orphan_batch_complete", "resolved", resolved, "deleted", deletedOrphans)
			if resolved > 0 {
				w.fileSync.Start("orphan_likes_resolved")
			}
			if !sleepContext(ctx, 2*time.Second) {
				w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
				return
			}
			continue
		}

		remaining, err := w.countLegacyLikes(ctx)
		if err != nil {
			w.markTaskError(ctx, def, "running", runID, "count_legacy_likes", err)
			return
		}
		if remaining == 0 {
			completedAt := time.Now().UTC()
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "completed", DesiredStatus: "stopped", ProgressPct: 100,
				CurrentValue: int64Ptr(total), TotalValue: int64Ptr(total), Unit: "likes",
				State:  map[string]any{"run_id": runID, "current_step": "completed"},
				Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
			})
			log.Info("likes migration completed", "event", "task_complete", "total", total)
			return
		}

		idle++
		sleep := time.Duration(30*(1<<min(idle, 7))) * time.Second
		if sleep > time.Hour {
			sleep = time.Hour
		}
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: percent(processedTotal, total),
			CurrentValue: int64Ptr(processedTotal), TotalValue: int64Ptr(total), Unit: "likes",
			State: map[string]any{
				"run_id": runID, "current_step": "idle_wait",
				"idle_count": idle, "sleep_seconds": int(sleep.Seconds()), "remaining_count": remaining,
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})
		log.Info("likes migration idle", "event", "idle_wait", "remaining", remaining, "sleep_seconds", int(sleep.Seconds()))
		if !sleepContext(ctx, sleep) {
			w.markTaskStopped(context.Background(), def, "running", runID, "context_cancelled")
			return
		}
	}
}

func (w *Worker) countLegacyLikes(ctx context.Context) (int64, error) {
	var count int64
	err := w.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM likes`).Scan(&count)
	return count, err
}

func (w *Worker) processLikesBatch(ctx context.Context, limit int) (int, error) {
	rows, err := w.db.QueryContext(ctx, `SELECT id FROM likes ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	likeIDs := make([]int64, 0, limit)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		likeIDs = append(likeIDs, id)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(likeIDs) == 0 {
		return 0, nil
	}

	postRows, err := w.db.QueryContext(ctx,
		`SELECT id FROM posts WHERE id = ANY($1)`, pq.Array(likeIDs))
	if err != nil {
		return 0, err
	}
	defer postRows.Close()

	existing := map[int64]bool{}
	for postRows.Next() {
		var id int64
		if err := postRows.Scan(&id); err != nil {
			return 0, err
		}
		existing[id] = true
	}
	if err := postRows.Err(); err != nil {
		return 0, err
	}
	if len(existing) == 0 {
		return 0, nil
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	processed := 0
	for _, id := range likeIDs {
		if !existing[id] {
			continue
		}
		// The post exists (checked above), so the legacy like is consumed
		// whether or not it was already liked.
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO post_likes (post_id) VALUES ($1) ON CONFLICT (post_id) DO NOTHING`, id); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM likes WHERE id = $1`, id); err != nil {
			return 0, err
		}
		processed++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return processed, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type orphanOutcome int

const (
	orphanOutcomeResolved orphanOutcome = iota
	orphanOutcomeDeleted
)

const orphanResolverRequestSpacing = 200 * time.Millisecond

func (w *Worker) processOrphanLikesBatch(ctx context.Context, log *slog.Logger, limit int) (int, int, error) {
	if limit <= 0 {
		return 0, 0, nil
	}
	rows, err := w.db.QueryContext(ctx, `
        SELECT l.id
        FROM likes l
        LEFT JOIN posts p ON p.id = l.id
        WHERE p.id IS NULL
        ORDER BY l.id DESC
        LIMIT $1`, limit)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	var orphanIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, 0, err
		}
		orphanIDs = append(orphanIDs, id)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}

	resolved := 0
	deleted := 0
	for _, id := range orphanIDs {
		select {
		case <-ctx.Done():
			return resolved, deleted, ctx.Err()
		default:
		}

		outcome, err := w.resolveOrphanLike(ctx, log, id)
		if err != nil {
			return resolved, deleted, err
		}
		switch outcome {
		case orphanOutcomeResolved:
			resolved++
		case orphanOutcomeDeleted:
			deleted++
		}
		if !sleepContext(ctx, orphanResolverRequestSpacing) {
			return resolved, deleted, ctx.Err()
		}
	}
	return resolved, deleted, nil
}

// resolveOrphanLike walks the konachan parent_id chain to find an active replacement
// for an orphan like. When found, the active post is upserted locally and liked
// in post_likes; when the chain dead-ends or konachan returns nothing, the legacy like row is
// dropped. Returning a non-nil error means the orphan is untouched and should be
// retried on the next cycle (typically a network/transient issue).
func (w *Worker) resolveOrphanLike(ctx context.Context, log *slog.Logger, originalID int64) (orphanOutcome, error) {
	visited := map[int64]bool{}
	currentID := originalID
	var resolved map[string]any

	for {
		if currentID == 0 || visited[currentID] {
			break
		}
		visited[currentID] = true

		post, err := w.fetchPostByID(ctx, currentID)
		if err != nil {
			return 0, err
		}
		if post == nil {
			break
		}
		if asString(post["status"]) != "deleted" {
			resolved = post
			break
		}
		currentID = asInt64(post["parent_id"])
	}

	if resolved != nil {
		finalID := asInt64(resolved["id"])
		if err := w.upsertPostAndConsumeLike(ctx, finalID, resolved, originalID); err != nil {
			return 0, err
		}
		log.Info("orphan like resolved", "event", "orphan_resolved", "original_like_id", originalID, "final_post_id", finalID)
		return orphanOutcomeResolved, nil
	}

	if _, err := w.db.ExecContext(ctx, `DELETE FROM likes WHERE id = $1`, originalID); err != nil {
		return 0, err
	}
	log.Info("orphan like deleted", "event", "orphan_deleted", "original_like_id", originalID)
	return orphanOutcomeDeleted, nil
}

func (w *Worker) fetchPostByID(ctx context.Context, id int64) (map[string]any, error) {
	url := fmt.Sprintf("https://konachan.net/post.json?tags=id:%d", id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := w.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote status %d for post id %d", resp.StatusCode, id)
	}
	decoder := json.NewDecoder(resp.Body)
	decoder.UseNumber()
	var posts []map[string]any
	if err := decoder.Decode(&posts); err != nil {
		return nil, err
	}
	if len(posts) == 0 {
		return nil, nil
	}
	return posts[0], nil
}

func (w *Worker) upsertPostAndConsumeLike(ctx context.Context, finalID int64, raw map[string]any, originalLikeID int64) error {
	rawBytes, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
        INSERT INTO posts (id, raw_data, last_synced_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (id) DO NOTHING`,
		finalID, string(rawBytes)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO post_likes (post_id) VALUES ($1) ON CONFLICT (post_id) DO NOTHING`, finalID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM likes WHERE id = $1`, originalLikeID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	w.markFamiliesDirty()
	return nil
}

// resolveMissingTagsViaAPI looks up tag names that are referenced by the
// current post batch but absent from the local tags table. Found tags are
// upserted (so the batch can finish indexing those posts immediately);
// names that konachan also has no record of are persisted to a blacklist
// in schedule_state so future batches don't keep retrying them.
//
// Network errors for individual names are logged and skipped (those names
// are NOT blacklisted, so the next cycle will retry them).
func (w *Worker) resolveMissingTagsViaAPI(
	ctx context.Context, log *slog.Logger,
	requested []string, nameToID map[string]int64,
) (map[string]bool, error) {
	state, err := w.store.GetScheduleState(ctx, postTagsScheduleKey)
	if err != nil {
		return nil, err
	}
	blacklist := loadStringSet(state, "unknown_tag_names")

	needsLookup := make([]string, 0)
	for _, name := range requested {
		if name == "" {
			continue
		}
		if _, ok := nameToID[name]; ok {
			continue
		}
		if blacklist[name] {
			continue
		}
		needsLookup = append(needsLookup, name)
	}
	if len(needsLookup) == 0 {
		return blacklist, nil
	}

	log.Info("resolving missing tags via konachan api",
		"event", "tag_resolver_start", "count", len(needsLookup))

	blacklistDirty := false
	resolvedCount := 0
	for _, name := range needsLookup {
		if ctx.Err() != nil {
			break
		}

		tag, fetchErr := w.fetchTagByName(ctx, name)
		switch {
		case fetchErr != nil:
			log.Warn("tag api lookup failed, will retry next cycle",
				"event", "tag_lookup_failed", "tag_name", name, "error", fetchErr)
		case tag == nil:
			blacklist[name] = true
			blacklistDirty = true
			log.Info("tag not found upstream, blacklisted",
				"event", "tag_unknown_upstream", "tag_name", name)
		default:
			if _, _, err := w.upsertTag(ctx, tag); err != nil {
				log.Warn("tag upsert failed",
					"event", "tag_upsert_failed", "tag_name", name, "error", err)
			} else {
				nameToID[name] = asInt64(tag["id"])
				resolvedCount++
				log.Info("missing tag resolved via api",
					"event", "tag_api_resolved",
					"tag_name", name, "tag_id", asInt64(tag["id"]))
			}
		}

		if !sleepContext(ctx, tagAPISpacing) {
			break
		}
	}

	log.Info("missing-tag resolver done",
		"event", "tag_resolver_done",
		"resolved", resolvedCount, "blacklisted_total", len(blacklist))

	if blacklistDirty {
		state["unknown_tag_names"] = stringSetToSlice(blacklist)
		if err := w.store.UpdateScheduleState(ctx, postTagsScheduleKey, state); err != nil {
			log.Warn("failed to persist tag blacklist",
				"event", "blacklist_persist_failed", "error", err)
		}
	}
	return blacklist, nil
}

// fetchTagByName queries konachan's tag.json by name and returns the entry
// whose name is an exact match. konachan's name parameter does prefix-style
// matching (e.g. ?name=foo can also return foo:artist), so we filter
// strictly. Returns nil when no exact match exists.
func (w *Worker) fetchTagByName(ctx context.Context, name string) (map[string]any, error) {
	endpoint := fmt.Sprintf("https://konachan.net/tag.json?name=%s", url.QueryEscape(name))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := w.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote status %d for tag name %q", resp.StatusCode, name)
	}
	decoder := json.NewDecoder(resp.Body)
	decoder.UseNumber()
	var tags []map[string]any
	if err := decoder.Decode(&tags); err != nil {
		return nil, err
	}
	for _, tag := range tags {
		if asString(tag["name"]) == name {
			return tag, nil
		}
	}
	return nil, nil
}

func loadStringSet(state map[string]any, key string) map[string]bool {
	out := map[string]bool{}
	raw, ok := state[key]
	if !ok {
		return out
	}
	arr, ok := raw.([]any)
	if !ok {
		return out
	}
	for _, v := range arr {
		if s := asString(v); s != "" {
			out[s] = true
		}
	}
	return out
}

func stringSetToSlice(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
