package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKonachanComAuthForScopesCookieToHost(t *testing.T) {
	w := &Worker{cfg: Config{
		KonachanComBase:     "https://konachan.com",
		KonachanCFClearance: "clearance-value",
		KonachanUserAgent:   "test-agent",
	}}
	cases := []struct {
		url      string
		wantAuth bool
	}{
		{"https://konachan.com/jpeg/abc/file.jpg", true},
		{"https://KONACHAN.COM/image/abc/file.png", true},
		{"https://files.konachan.com/jpeg/abc/file.jpg", true},
		{"https://konachan.net/jpeg/abc/file.jpg", false},
		{"https://evilkonachan.com/jpeg/abc/file.jpg", false},
		{"https://konachan.com.example.org/file.jpg", false},
		{"::not a url", false},
	}
	for _, c := range cases {
		cookie, ua := w.konachanComAuthFor(c.url)
		if got := cookie != "" && ua != ""; got != c.wantAuth {
			t.Errorf("konachanComAuthFor(%q) auth=%v, want %v", c.url, got, c.wantAuth)
		}
		if c.wantAuth && (cookie != "cf_clearance=clearance-value" || ua != "test-agent") {
			t.Errorf("konachanComAuthFor(%q) = %q, %q", c.url, cookie, ua)
		}
	}

	w.cfg.KonachanCFClearance = ""
	if cookie, ua := w.konachanComAuthFor("https://konachan.com/jpeg/x.jpg"); cookie != "" || ua != "" {
		t.Errorf("without clearance got %q, %q", cookie, ua)
	}
}

func TestRedactAriaParamsHidesHeaders(t *testing.T) {
	options := map[string]any{"dir": "/d", "header": []string{"Cookie: cf_clearance=secret"}}
	params := []any{[]string{"https://konachan.com/x.jpg"}, options}

	logged, err := json.Marshal(redactAriaParams(params))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(logged), "secret") {
		t.Fatalf("redacted params still contain the cookie: %s", logged)
	}
	if _, ok := options["header"].([]string); !ok {
		t.Fatal("redaction must not modify the params sent to aria2")
	}
}
