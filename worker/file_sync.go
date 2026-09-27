package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
)

type FileSyncController struct {
	worker  *Worker
	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	runID   string
}

type FileSyncStats struct {
	PendingLiked int64
	Pending      int64
	Downloading  int64
	Complete     int64
	Deleted      int64
	Failed       int64
}

type fileSyncRecord struct {
	ID           int64
	PostID       int64
	FilePath     string
	ExpectedSize sql.NullInt64
}

func NewFileSyncController(worker *Worker) *FileSyncController {
	return &FileSyncController{worker: worker}
}

func (c *FileSyncController) Start(reason string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running {
		return map[string]any{"status": "already_running", "run_id": c.runID}
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.running = true
	c.cancel = cancel
	c.runID = runID()
	go c.worker.runFileSyncAdaptive(ctx, c.runID, reason)
	return map[string]any{"status": "triggered", "run_id": c.runID}
}

func (c *FileSyncController) Stop(reason string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.running {
		return map[string]any{"status": "not_running"}
	}
	c.cancel()
	return map[string]any{"status": "stopping", "run_id": c.runID, "reason": reason}
}

func (c *FileSyncController) Status() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	status := "stopped"
	if c.running {
		status = "running"
	}
	return map[string]any{"status": status, "run_id": c.runID}
}

func (c *FileSyncController) finish() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	c.cancel = nil
}

func (w *Worker) runFileSyncAdaptive(ctx context.Context, runID, reason string) {
	taskID := "file-sync"
	def := taskDef(taskID)
	log := w.log.With("task", taskID, "run_id", runID)
	startedAt := time.Now().UTC()
	emptyChecks := 0
	defer w.fileSync.finish()

	log.Info("file sync started", "event", "task_start", "trigger_reason", reason)
	for {
		select {
		case <-ctx.Done():
			w.markTaskStopped(context.Background(), def, "stopped", runID, "trigger_stop")
			return
		default:
		}

		cycleStart := time.Now()
		created, completed, deleted, err := w.runFileSyncCycle(ctx, runID)
		if err != nil {
			w.markTaskError(ctx, def, "stopped", runID, "file_sync_cycle", err)
			log.Error("file sync cycle failed", "event", "task_error", "phase", "file_sync_cycle", "error", err)
			return
		}
		stats, err := w.fileSyncStats(ctx)
		if err != nil {
			w.markTaskError(ctx, def, "stopped", runID, "file_sync_stats", err)
			return
		}
		activity := created + completed + deleted
		if activity == 0 {
			emptyChecks++
		} else {
			emptyChecks = 0
		}

		now := time.Now().UTC()
		activeTotal := stats.PendingLiked + stats.Pending + stats.Downloading
		progress := 100.0
		if activeTotal > 0 {
			progress = 50
		}
		totalValue := stats.PendingLiked + stats.Pending + stats.Downloading + stats.Complete + stats.Deleted + stats.Failed
		currentValue := stats.Complete + stats.Deleted
		_ = w.store.UpdateTask(ctx, TaskSnapshot{
			ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
			Status: "running", DesiredStatus: "running", ProgressPct: progress,
			CurrentValue: int64Ptr(currentValue), TotalValue: int64Ptr(totalValue), Unit: "files",
			State: map[string]any{
				"run_id": runID, "current_step": "cycle_complete",
				"last_cycle_created": created, "last_cycle_completed": completed, "last_cycle_deleted": deleted,
				"pending_liked_posts": stats.PendingLiked, "pending_count": stats.Pending,
				"downloading_count": stats.Downloading, "complete_count": stats.Complete,
				"deleted_count": stats.Deleted, "failed_count": stats.Failed,
				"empty_checks": emptyChecks, "idle_limit": w.cfg.FileSyncIdleLimit,
				"duration_ms":   time.Since(cycleStart).Milliseconds(),
				"progress_kind": "queue",
			},
			Config: def.Config, StartedAt: &startedAt, LastRunAt: &now,
		})
		log.Info("file sync cycle completed", "event", "cycle_complete", "created", created, "completed", completed, "deleted", deleted, "empty_checks", emptyChecks, "duration_ms", time.Since(cycleStart).Milliseconds())

		if emptyChecks >= w.cfg.FileSyncIdleLimit {
			completedAt := time.Now().UTC()
			_ = w.store.UpdateTask(ctx, TaskSnapshot{
				ID: def.ID, Name: def.Name, Type: def.Type, Category: def.Category,
				Status: "completed", DesiredStatus: "stopped", ProgressPct: 100,
				CurrentValue: int64Ptr(currentValue), TotalValue: int64Ptr(totalValue), Unit: "files",
				State: map[string]any{
					"run_id": runID, "current_step": "idle_complete",
					"empty_checks": emptyChecks, "idle_limit": w.cfg.FileSyncIdleLimit,
					"pending_liked_posts": stats.PendingLiked, "downloading_count": stats.Downloading,
					"complete_count": stats.Complete, "deleted_count": stats.Deleted,
				},
				Config: def.Config, StartedAt: &startedAt, CompletedAt: &completedAt, LastRunAt: &completedAt,
			})
			log.Info("file sync stopped after idle limit", "event", "task_complete", "empty_checks", emptyChecks)
			return
		}

		interval := 30 * time.Second
		switch {
		case emptyChecks == 0:
			interval = 30 * time.Second
		case emptyChecks <= 3:
			interval = time.Minute
		case emptyChecks <= 6:
			interval = 2 * time.Minute
		default:
			interval = 3 * time.Minute
		}
		if !sleepContext(ctx, interval) {
			w.markTaskStopped(context.Background(), def, "stopped", runID, "trigger_stop")
			return
		}
	}
}

func (w *Worker) runFileSyncCycle(ctx context.Context, runID string) (created, completed, deleted int, err error) {
	created, err = w.checkLikedPosts(ctx, runID)
	if err != nil {
		return 0, 0, 0, err
	}
	completed, err = w.checkDownloadStatus(ctx, runID)
	if err != nil {
		return created, 0, 0, err
	}
	deleted, err = w.checkUnlikedPosts(ctx, runID)
	return created, completed, deleted, err
}

func (w *Worker) fileSyncStats(ctx context.Context) (FileSyncStats, error) {
	stats := FileSyncStats{}
	err := w.db.QueryRowContext(ctx,
		`SELECT COUNT(*)
		 FROM post_likes l
		 LEFT JOIN file_sync fs ON l.post_id = fs.post_id AND fs.sync_status NOT IN ('DELETED')
		 WHERE fs.post_id IS NULL`).Scan(&stats.PendingLiked)
	if err != nil {
		return stats, err
	}
	rows, err := w.db.QueryContext(ctx, `SELECT sync_status, COUNT(*) FROM file_sync GROUP BY sync_status`)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return stats, err
		}
		switch strings.ToUpper(status) {
		case "PENDING":
			stats.Pending = count
		case "DOWNLOADING":
			stats.Downloading = count
		case "COMPLETE":
			stats.Complete = count
		case "DELETED":
			stats.Deleted = count
		case "FAILED":
			stats.Failed = count
		}
	}
	return stats, rows.Err()
}

func (w *Worker) checkLikedPosts(ctx context.Context, runID string) (int, error) {
	log := w.log.With("task", "file-sync", "run_id", runID, "phase", "liked_posts")
	rows, err := w.db.QueryContext(ctx,
		`SELECT p.id, p.raw_data
		 FROM post_likes l
		 JOIN posts p ON p.id = l.post_id
		 LEFT JOIN file_sync fs ON p.id = fs.post_id AND fs.sync_status NOT IN ('DELETED')
		 WHERE fs.post_id IS NULL
		 ORDER BY p.id DESC
		 LIMIT 100`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	processed := 0
	failed := 0
	for rows.Next() {
		var postID int64
		var rawBytes []byte
		if err := rows.Scan(&postID, &rawBytes); err != nil {
			return processed, err
		}
		raw := decodeJSON(rawBytes)
		existing := checkFileExists(w.cfg.DownloadBasePath, postID)
		if existing != "" {
			if err := w.createCompleteRecord(ctx, postID, raw, existing); err != nil {
				failed++
				log.Error("failed to create complete record", "event", "file_sync_error", "post_id", postID, "file_path", existing, "error", err)
				continue
			}
			processed++
			log.Info("existing file recorded", "event", "existing_file_recorded", "post_id", postID, "file_path", existing)
			continue
		}
		if err := w.createDownloadTask(ctx, postID, raw, log); err != nil {
			failed++
			log.Error("failed to create download task", "event", "file_sync_error", "post_id", postID, "error", err)
			continue
		}
		processed++
	}
	if err := rows.Err(); err != nil {
		return processed, err
	}
	log.Info("liked posts check complete", "event", "phase_complete", "processed", processed, "failed", failed)
	return processed, nil
}

func (w *Worker) createCompleteRecord(ctx context.Context, postID int64, raw map[string]any, existingFile string) error {
	stat, err := os.Stat(existingFile)
	if err != nil {
		return err
	}
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(existingFile)), ".")
	downloadURL := asString(raw["file_url"])
	expectedSize := asInt64(raw["file_size"])
	if ext == "jpg" || ext == "jpeg" {
		downloadURL = asString(raw["jpeg_url"])
		expectedSize = asInt64(raw["jpeg_file_size"])
		if expectedSize == 0 || downloadURL == "" {
			downloadURL = asString(raw["file_url"])
			expectedSize = asInt64(raw["file_size"])
		}
	}
	if downloadURL == "" {
		downloadURL = "N/A"
	}
	_, err = w.db.ExecContext(ctx,
		`INSERT INTO file_sync (post_id, download_url, expected_size, actual_size, file_path, file_ext, sync_status)
		 VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE')`,
		postID, downloadURL, expectedSize, stat.Size(), existingFile, ext)
	return err
}

func (w *Worker) createDownloadTask(ctx context.Context, postID int64, raw map[string]any, log *slog.Logger) error {
	downloadURL, expectedSize, ext := preferredDownload(raw, log.With("post_id", postID))
	if downloadURL == "" {
		return fmt.Errorf("no download url")
	}
	cookie, userAgent := w.konachanComAuthFor(downloadURL)
	if err := validateDownloadURL(ctx, w.httpClient, downloadURL, cookie, userAgent); err != nil {
		return fmt.Errorf("download url validation failed: %w", err)
	}
	idxDir := getIdxPath(w.cfg.DownloadBasePath, postID)
	if err := os.MkdirAll(idxDir, 0755); err != nil {
		return fmt.Errorf("create download directory: %w", err)
	}
	tags := asString(raw["tags"])
	filename := buildFilename(postID, tags, downloadURL)
	filePath := filepath.Join(idxDir, filename)

	ariaOptions := map[string]any{"dir": idxDir, "out": filename}
	if cookie != "" {
		ariaOptions["header"] = []string{"Cookie: " + cookie}
	}
	if userAgent != "" {
		ariaOptions["user-agent"] = userAgent
	}
	ariaParams := []any{[]string{downloadURL}, ariaOptions}
	gid, ariaLog, err := w.sendAria2Request(ctx, "aria2.addUri", ariaParams)
	if err != nil {
		return err
	}
	_, err = w.db.ExecContext(ctx,
		`INSERT INTO file_sync (post_id, download_url, expected_size, file_path, file_ext, aria_log, sync_status)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'DOWNLOADING')`,
		postID, downloadURL, expectedSize, filePath, ext, ariaLog)
	if err != nil {
		return err
	}
	log.Info("download task created", "event", "download_task_created", "post_id", postID, "file_path", filePath, "aria_gid", gid, "expected_size", expectedSize)
	return nil
}

// sendAria2Request calls aria2 over JSON-RPC and returns the gid plus a log
// record of the call. The log is stored in file_sync.aria_log, so it omits
// the RPC token and redacts request headers (they carry cf_clearance).
func (w *Worker) sendAria2Request(ctx context.Context, method string, params []any) (string, string, error) {
	loggedParams := redactAriaParams(params)
	if w.cfg.Aria2Secret != "" {
		params = append([]any{"token:" + w.cfg.Aria2Secret}, params...)
	}
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "konakore-worker",
		"method":  method,
		"params":  params,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", "", err
	}
	resp, err := httpJSON(ctx, w.httpClient, http.MethodPost, ariaHTTPURL(w.cfg.Aria2URL), bytes.NewReader(raw))
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("aria2 status %d", resp.StatusCode)
	}
	var result struct {
		Result any `json:"result"`
		Error  any `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", "", err
	}
	if result.Error != nil {
		return "", "", fmt.Errorf("aria2 error: %v", result.Error)
	}
	gid := fmt.Sprint(result.Result)
	ariaLog, _ := json.Marshal(map[string]any{"gid": gid, "method": method, "params": loggedParams})
	return gid, string(ariaLog), nil
}

// redactAriaParams copies params with any "header" option replaced.
func redactAriaParams(params []any) []any {
	out := make([]any, len(params))
	for i, param := range params {
		options, ok := param.(map[string]any)
		if !ok {
			out[i] = param
			continue
		}
		copied := make(map[string]any, len(options))
		for key, value := range options {
			copied[key] = value
		}
		if _, has := copied["header"]; has {
			copied["header"] = "[redacted]"
		}
		out[i] = copied
	}
	return out
}

func (w *Worker) checkDownloadStatus(ctx context.Context, runID string) (int, error) {
	log := w.log.With("task", "file-sync", "run_id", runID, "phase", "download_status")
	rows, err := w.db.QueryContext(ctx,
		`SELECT id, post_id, file_path, expected_size
		 FROM file_sync
		 WHERE sync_status = 'DOWNLOADING'`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	records := make([]fileSyncRecord, 0)
	for rows.Next() {
		var record fileSyncRecord
		if err := rows.Scan(&record.ID, &record.PostID, &record.FilePath, &record.ExpectedSize); err != nil {
			return 0, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	completed := 0
	for _, record := range records {
		stat, err := os.Stat(record.FilePath)
		if err != nil {
			continue
		}
		if _, err := w.db.ExecContext(ctx,
			`UPDATE file_sync
			 SET sync_status = 'COMPLETE', actual_size = $1, updated_at = NOW()
			 WHERE id = $2`,
			stat.Size(), record.ID); err != nil {
			return completed, err
		}
		completed++
		log.Info("download completed", "event", "download_completed", "post_id", record.PostID, "file_path", record.FilePath, "actual_size", stat.Size())
	}
	log.Info("download status check complete", "event", "phase_complete", "completed", completed, "downloading_checked", len(records))
	return completed, nil
}

func (w *Worker) checkUnlikedPosts(ctx context.Context, runID string) (int, error) {
	deleted, err := w.cleanupByDatabase(ctx, runID)
	if err != nil {
		return deleted, err
	}
	w.cleanupCounter++
	if w.cleanupCounter >= 10 {
		fsDeleted, err := w.cleanupByFilesystem(ctx, runID, 100)
		if err != nil {
			return deleted, err
		}
		deleted += fsDeleted
		w.cleanupCounter = 0
	}
	return deleted, nil
}

func (w *Worker) cleanupByDatabase(ctx context.Context, runID string) (int, error) {
	log := w.log.With("task", "file-sync", "run_id", runID, "phase", "cleanup_database")
	rows, err := w.db.QueryContext(ctx,
		`SELECT fs.id, fs.post_id, fs.file_path, fs.sync_status
		 FROM file_sync fs
		 JOIN posts p ON fs.post_id = p.id
		 WHERE fs.sync_status = 'COMPLETE'
		   AND fs.is_deleted = FALSE
		   AND NOT EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id)
		 LIMIT 100`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type target struct {
		postID   int64
		filePath string
	}
	targets := make([]target, 0)
	for rows.Next() {
		var id int64
		var status string
		var item target
		if err := rows.Scan(&id, &item.postID, &item.filePath, &status); err != nil {
			return 0, err
		}
		targets = append(targets, item)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	deleted := 0
	for _, item := range targets {
		if err := w.deleteFileAndUpdateRecord(ctx, item.postID, item.filePath); err != nil {
			log.Error("failed to delete unliked file", "event", "file_delete_failed", "post_id", item.postID, "file_path", item.filePath, "error", err)
			continue
		}
		deleted++
		log.Info("unliked file deleted", "event", "file_deleted", "post_id", item.postID, "file_path", item.filePath)
	}
	log.Info("database cleanup complete", "event", "phase_complete", "deleted", deleted)
	return deleted, nil
}

func (w *Worker) cleanupByFilesystem(ctx context.Context, runID string, maxDirs int) (int, error) {
	log := w.log.With("task", "file-sync", "run_id", runID, "phase", "cleanup_filesystem")
	dirs, err := filepath.Glob(filepath.Join(w.cfg.DownloadBasePath, "[0-9][0-9]"))
	if err != nil {
		return 0, err
	}
	if len(dirs) > maxDirs {
		dirs = dirs[:maxDirs]
	}
	deleted := 0
	postIDPattern := regexp.MustCompile(`Konachan\.com - (\d+)`)
	for _, dir := range dirs {
		files, err := filepath.Glob(filepath.Join(dir, "Konachan.com - *"))
		if err != nil {
			return deleted, err
		}
		postFile := map[int64]string{}
		ids := make([]int64, 0, len(files))
		for _, file := range files {
			match := postIDPattern.FindStringSubmatch(filepath.Base(file))
			if len(match) != 2 {
				continue
			}
			id, err := strconv.ParseInt(match[1], 10, 64)
			if err != nil {
				continue
			}
			postFile[id] = file
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			continue
		}
		rows, err := w.db.QueryContext(ctx,
			`SELECT p.id, EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id)
			 FROM posts p WHERE p.id = ANY($1)`, pq.Array(ids))
		if err != nil {
			return deleted, err
		}
		status := map[int64]bool{}
		for rows.Next() {
			var id int64
			var liked bool
			if err := rows.Scan(&id, &liked); err != nil {
				rows.Close()
				return deleted, err
			}
			status[id] = liked
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return deleted, err
		}
		rows.Close()
		for id, file := range postFile {
			if liked, ok := status[id]; ok && !liked {
				if err := w.deleteFileAndUpdateRecord(ctx, id, file); err != nil {
					log.Error("failed to delete filesystem file", "event", "file_delete_failed", "post_id", id, "file_path", file, "error", err)
					continue
				}
				deleted++
			}
		}
	}
	log.Info("filesystem cleanup complete", "event", "phase_complete", "deleted", deleted, "dirs_checked", len(dirs))
	return deleted, nil
}

func (w *Worker) deleteFileAndUpdateRecord(ctx context.Context, postID int64, filePath string) error {
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE file_sync
		 SET sync_status = 'DELETED', is_deleted = TRUE, updated_at = NOW()
		 WHERE post_id = $1 AND sync_status != 'DELETED'`,
		postID)
	if err != nil {
		return err
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO file_sync (post_id, download_url, file_path, sync_status, is_deleted)
			 VALUES ($1, 'N/A', $2, 'DELETED', TRUE)`,
			postID, filePath); err != nil {
			return err
		}
	}
	return tx.Commit()
}
