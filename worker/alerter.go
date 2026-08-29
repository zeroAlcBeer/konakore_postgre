package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// AlertEvent is the unified alert schema pushed to alertcenter. The worker
// is responsible for generating a stable fingerprint and setting status to
// "firing" or "resolved" — the center never infers business semantics.
type AlertEvent struct {
	Source      string            `json:"source"`
	EventID     string            `json:"event_id"`
	Severity    string            `json:"severity"`
	Fingerprint string            `json:"fingerprint"`
	Status      string            `json:"status"`
	Message     string            `json:"message"`
	Timestamp   string            `json:"timestamp"`
	Context     map[string]string `json:"context,omitempty"`
}

// Alerter pushes semantic alert events to the central alertcenter service.
// It is best-effort: a failed push is logged but never blocks the worker.
type Alerter struct {
	url    string
	client *http.Client
	log    *slog.Logger
}

func NewAlerter(url string, log *slog.Logger) *Alerter {
	if url == "" {
		return nil
	}
	return &Alerter{
		url:    strings.TrimRight(url, "/") + "/api/v1/events",
		client: &http.Client{Timeout: 10 * time.Second},
		log:    log,
	}
}

// Push sends a single alert event. It never returns an error — failures are
// logged so the caller can stay simple.
func (a *Alerter) Push(ctx context.Context, ev AlertEvent) {
	if a == nil {
		return
	}
	if ev.Timestamp == "" {
		ev.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	body, err := json.Marshal(ev)
	if err != nil {
		a.log.Warn("alert marshal failed", "fingerprint", ev.Fingerprint, "error", err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.url, bytes.NewReader(body))
	if err != nil {
		a.log.Warn("alert request build failed", "fingerprint", ev.Fingerprint, "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		a.log.Warn("alert push failed", "fingerprint", ev.Fingerprint, "error", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		a.log.Warn("alert push non-2xx", "fingerprint", ev.Fingerprint, "status", resp.StatusCode)
		return
	}
	a.log.Info("alert pushed", "source", ev.Source, "event_id", ev.EventID, "status", ev.Status, "fingerprint", ev.Fingerprint)
}

// fingerprintForError derives a stable fingerprint from a task error. For
// cf_clearance failures the fingerprint is semantic (konakore:cf_clearance:konachan.com)
// so all retries collapse into one alert. For other errors the fingerprint
// includes the task id and phase.
func fingerprintForError(taskID, phase string, err error) string {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	if strings.Contains(msg, "cf_clearance") || strings.Contains(msg, "konachan.com status 403") {
		return "konakore:cf_clearance:konachan.com"
	}
	return fmt.Sprintf("konakore:task_error:%s:%s", taskID, phase)
}
