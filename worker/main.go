package main

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

const serviceName = "konakore-worker"

type Config struct {
	PostgresHost     string
	PostgresPort     string
	PostgresDB       string
	PostgresUser     string
	PostgresPassword string

	HTTPAddr         string
	Aria2URL         string
	Aria2Secret      string
	DownloadBasePath string

	RecentInterval      time.Duration
	TagsInterval        time.Duration
	BackfillStartDelay  time.Duration
	BackfillRetryDelay  time.Duration
	BackfillMaxBackoff  time.Duration
	PostTagsBatchSize   int
	LikesBatchSize      int
	FileSyncIdleLimit   int
	HTTPClientTimeout   time.Duration
	ShutdownGracePeriod time.Duration

	// Konachan.com (explicit/questionable source behind Cloudflare). konachan.net
	// is safe-only, so q/e posts must be fetched from konachan.com using a
	// browser-issued cf_clearance cookie plus moebooru login credentials.
	KonachanComBase      string
	KonachanLogin        string
	KonachanPasswordHash string
	KonachanCFClearance  string
	KonachanUserAgent    string

	RangeBackfillInterval     time.Duration
	RangeBackfillTailInterval time.Duration
	RangeBackfillStartID      int64
	RangeBackfillWindow       int64

	// Central alerting — push semantic events to alertcenter.
	AlertcenterURL string
}

type Worker struct {
	cfg                   Config
	db                    *sql.DB
	store                 *TaskStore
	log                   *slog.Logger
	httpClient            *http.Client
	fileSync              *FileSyncController
	cleanupCounter        int
	embeddingsRebuildLock sync.Mutex
	alerter               *Alerter
	familiesDirty         atomic.Bool // set by posts writers; see jobs_families.go
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		AddSource: true,
		Level:     slog.LevelInfo,
	})).With("service", serviceName)

	cfg := loadConfig()
	db, err := openDB(cfg)
	if err != nil {
		logger.Error("worker startup failed", "event", "startup_failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store := NewTaskStore(db, logger)
	if err := store.EnsureSchema(ctx); err != nil {
		logger.Error("failed to ensure task schema", "event", "schema_failed", "error", err)
		os.Exit(1)
	}
	if err := importTagNames(ctx, db, logger, tagNamesZhGz); err != nil {
		logger.Error("failed to import tag names", "event", "tag_names_failed", "error", err)
		os.Exit(1)
	}

	worker := &Worker{
		cfg:        cfg,
		db:         db,
		store:      store,
		log:        logger,
		httpClient: &http.Client{Timeout: cfg.HTTPClientTimeout},
		alerter:    NewAlerter(cfg.AlertcenterURL, logger),
	}
	worker.fileSync = NewFileSyncController(worker)

	if err := worker.seedTasks(ctx); err != nil {
		logger.Error("failed to seed task state", "event", "task_seed_failed", "error", err)
		os.Exit(1)
	}

	server := worker.newHTTPServer()
	go func() {
		logger.Info("worker http server starting", "event", "http_start", "addr", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("worker http server failed", "event", "http_failed", "error", err)
			stop()
		}
	}()

	worker.startBackgroundTasks(ctx)

	<-ctx.Done()
	logger.Info("worker shutdown requested", "event", "shutdown_requested")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGracePeriod)
	defer cancel()
	worker.fileSync.Stop("shutdown")
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("worker http shutdown failed", "event", "http_shutdown_failed", "error", err)
	}
	logger.Info("worker stopped", "event", "shutdown_complete")
}

func loadConfig() Config {
	return Config{
		PostgresHost:     envString("POSTGRES_HOST", "postgres"),
		PostgresPort:     envString("POSTGRES_PORT", "5432"),
		PostgresDB:       envString("POSTGRES_DB", "konakore"),
		PostgresUser:     envString("POSTGRES_USER", "konakore"),
		PostgresPassword: envString("POSTGRES_PASSWORD", "secret"),

		HTTPAddr:         envString("WORKER_HTTP_ADDR", ":8090"),
		Aria2URL:         envString("ARIA2_URL", "http://localhost:6800/jsonrpc"),
		Aria2Secret:      envString("ARIA2_SECRET", ""),
		DownloadBasePath: envString("DOWNLOAD_BASE_PATH", "/wallpaper"),

		RecentInterval:      envDuration("RECENT_SYNC_INTERVAL", 3*time.Hour),
		TagsInterval:        envDuration("TAGS_SYNC_INTERVAL", 7*24*time.Hour),
		BackfillStartDelay:  envDuration("BACKFILL_START_DELAY", 2*time.Second),
		BackfillRetryDelay:  envDuration("BACKFILL_RETRY_DELAY", 60*time.Second),
		BackfillMaxBackoff:  envDuration("BACKFILL_MAX_BACKOFF", time.Hour),
		PostTagsBatchSize:   envInt("POST_TAGS_BATCH_SIZE", 100),
		LikesBatchSize:      envInt("LIKES_BATCH_SIZE", 100),
		FileSyncIdleLimit:   envInt("FILE_SYNC_IDLE_LIMIT", 10),
		HTTPClientTimeout:   envDuration("WORKER_HTTP_TIMEOUT", 120*time.Second),
		ShutdownGracePeriod: envDuration("WORKER_SHUTDOWN_GRACE", 10*time.Second),

		KonachanComBase:      envString("KONACHAN_COM_BASE", "https://konachan.com"),
		KonachanLogin:        envString("KONACHAN_LOGIN", ""),
		KonachanPasswordHash: konachanPasswordHash(),
		KonachanCFClearance:  envString("KONACHAN_CF_CLEARANCE", ""),
		KonachanUserAgent:    envString("KONACHAN_USER_AGENT", ""),

		RangeBackfillInterval:     envDuration("RANGE_BACKFILL_INTERVAL", 48*time.Minute),
		RangeBackfillTailInterval: envDuration("RANGE_BACKFILL_TAIL_INTERVAL", 48*time.Minute),
		RangeBackfillStartID:      envInt64("RANGE_BACKFILL_START_ID", 404000),
		RangeBackfillWindow:       envInt64("RANGE_BACKFILL_WINDOW", 100),

		AlertcenterURL: envString("ALERTCENTER_URL", ""),
	}
}

// konachanPasswordHash returns the moebooru-salted SHA1 of the account
// password. KONACHAN_PASSWORD_HASH takes precedence; otherwise it is derived
// from KONACHAN_PASSWORD using konachan's salt.
func konachanPasswordHash() string {
	if h := os.Getenv("KONACHAN_PASSWORD_HASH"); h != "" {
		return h
	}
	pw := os.Getenv("KONACHAN_PASSWORD")
	if pw == "" {
		return ""
	}
	sum := sha1.Sum([]byte("So-I-Heard-You-Like-Mupkids-?--" + pw + "--"))
	return hex.EncodeToString(sum[:])
}

func envString(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func openDB(cfg Config) (*sql.DB, error) {
	dsn := "host=" + cfg.PostgresHost +
		" port=" + cfg.PostgresPort +
		" dbname=" + cfg.PostgresDB +
		" user=" + cfg.PostgresUser +
		" password=" + cfg.PostgresPassword +
		" sslmode=disable"
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for {
		if err := db.PingContext(ctx); err == nil {
			return db, nil
		}
		select {
		case <-ctx.Done():
			db.Close()
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
