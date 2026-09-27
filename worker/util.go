package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var filenameUnsafe = regexp.MustCompile(`[\\/:*?"<>|]`)

func asInt64(value any) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		i, _ := v.Int64()
		return i
	case string:
		i, _ := strconv.ParseInt(v, 10, 64)
		return i
	default:
		return 0
	}
}

func asFloat64(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	default:
		return 0
	}
}

func asString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	default:
		return ""
	}
}

func asBool(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return v == "true"
	default:
		return false
	}
}

func decodeJSON(raw []byte) map[string]any {
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return map[string]any{}
	}
	return result
}

func getIdxPath(basePath string, postID int64) string {
	idx := postID / 10000
	return filepath.Join(basePath, fmt.Sprintf("%02d", idx))
}

func cleanTagsForFilename(tags string) string {
	if tags == "" {
		return ""
	}
	parts := strings.Fields(tags)
	for len(strings.Join(parts, " ")) >= 200 && len(parts) > 0 {
		parts = parts[:len(parts)-1]
	}
	return filenameUnsafe.ReplaceAllString(strings.Join(parts, " "), "")
}

func buildFilename(postID int64, tags, downloadURL string) string {
	ext := "jpg"
	lower := strings.ToLower(downloadURL)
	if strings.Contains(lower, "png") {
		ext = "png"
	} else if strings.Contains(lower, "gif") {
		ext = "gif"
	}
	cleaned := cleanTagsForFilename(tags)
	if cleaned == "" {
		return fmt.Sprintf("Konachan.com - %d.%s", postID, ext)
	}
	return fmt.Sprintf("Konachan.com - %d %s.%s", postID, cleaned, ext)
}

func checkFileExists(basePath string, postID int64) string {
	idxPath := getIdxPath(basePath, postID)
	if _, err := os.Stat(idxPath); err != nil {
		return ""
	}
	patterns := []string{
		filepath.Join(idxPath, fmt.Sprintf("Konachan.com - %d *", postID)),
		filepath.Join(idxPath, fmt.Sprintf("Konachan.com - %d.*", postID)),
	}
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			return matches[0]
		}
	}
	return ""
}

func preferredDownload(raw map[string]any, logger *slog.Logger) (downloadURL string, expectedSize int64, ext string) {
	jpegSize := asInt64(raw["jpeg_file_size"])
	fileSize := asInt64(raw["file_size"])
	jpegURL := asString(raw["jpeg_url"])
	fileURL := asString(raw["file_url"])

	if jpegSize == 0 {
		downloadURL = fileURL
		expectedSize = fileSize
	} else {
		ratio := float64(fileSize) / float64(jpegSize)
		if ratio >= 10 {
			downloadURL = jpegURL
			expectedSize = jpegSize
			logger.Info("selected jpeg download", "event", "download_url_selected", "reason", "high_compression_ratio", "ratio", ratio)
		} else if ratio >= 3 && fileSize > 5*1024*1024 {
			downloadURL = jpegURL
			expectedSize = jpegSize
			logger.Info("selected jpeg download", "event", "download_url_selected", "reason", "large_file_medium_ratio", "ratio", ratio)
		} else {
			downloadURL = fileURL
			expectedSize = fileSize
			logger.Info("selected original download", "event", "download_url_selected", "reason", "preserve_original", "ratio", ratio)
		}
	}

	lower := strings.ToLower(downloadURL)
	switch {
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		ext = "jpg"
	case strings.HasSuffix(lower, ".png"):
		ext = "png"
	case strings.HasSuffix(lower, ".gif"):
		ext = "gif"
	default:
		ext = "jpg"
	}
	return downloadURL, expectedSize, ext
}

// validateDownloadURL HEADs downloadURL; cookie and userAgent are sent when
// non-empty (Cloudflare-protected hosts need both).
func validateDownloadURL(ctx context.Context, client *http.Client, downloadURL, cookie, userAgent string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, downloadURL, nil)
	if err != nil {
		return err
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	return nil
}

func httpJSON(ctx context.Context, client *http.Client, method, rawURL string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return client.Do(req)
}

func ariaHTTPURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	if parsed.Scheme == "ws" {
		parsed.Scheme = "http"
	}
	if parsed.Scheme == "wss" {
		parsed.Scheme = "https"
	}
	return parsed.String()
}

func tableExists(ctx context.Context, db *sql.DB, tableName string) (bool, error) {
	var exists bool
	err := db.QueryRowContext(ctx,
		`SELECT to_regclass($1) IS NOT NULL`, "public."+tableName).Scan(&exists)
	return exists, err
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func isNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
