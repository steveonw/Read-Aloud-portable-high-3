package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

const (
	appName       = "ReadAloud Lessac High"
	editionID     = "lessac-high"
	preferredAddr = "127.0.0.1:17392"
	idleTimeout   = 30 * time.Minute
)

var (
	lastRequest  atomic.Int64
	buildVersion = "dev"
)

func main() {
	sharedFlag := flag.String("shared", "", "path to the shared web application")
	noBrowser := flag.Bool("no-browser", false, "do not open the default browser")
	flag.Parse()

	logger, closeLog := newLogger()
	defer closeLog()

	sharedDir, err := locateShared(*sharedFlag)
	if err != nil {
		fatal(logger, err)
	}

	if err := validatePayload(sharedDir); err != nil {
		fatal(logger, err)
	}

	if existingURL, ok := findExistingServer(sharedDir); ok {
		if !*noBrowser {
			_ = openBrowser(existingURL)
		}
		return
	}

	listener, err := net.Listen("tcp", preferredAddr)
	if err != nil {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal(logger, fmt.Errorf("start local server: %w", err))
		}
	}

	appFingerprint, err := fingerprint(sharedDir)
	if err != nil {
		fatal(logger, fmt.Errorf("fingerprint app: %w", err))
	}

	lastRequest.Store(time.Now().UnixNano())
	mux := http.NewServeMux()
	files := http.FileServer(http.Dir(sharedDir))

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "readaloud:"+appFingerprint)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !validHost(r.Host) {
			http.Error(w, "invalid host", http.StatusForbidden)
			return
		}
		lastRequest.Store(time.Now().UnixNano())
		setHeaders(w, r.URL.Path)
		files.ServeHTTP(w, r)
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	addr := listener.Addr().String()
	url := "http://" + addr + "/?edition=" + editionID + "&build=" + appFingerprint
	logger.Printf("%s %s serving %s from %s", appName, buildVersion, url, sharedDir)

	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			logger.Printf("could not open browser automatically: %v", err)
			_ = writeOpenMe(sharedDir, url)
		}
	}

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			last := time.Unix(0, lastRequest.Load())
			if time.Since(last) >= idleTimeout {
				logger.Printf("stopping after %s without file requests", idleTimeout)
				_ = server.Shutdown(context.Background())
				close(done)
				return
			}
		}
	}()

	err = server.Serve(listener)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		fatal(logger, fmt.Errorf("local server: %w", err))
	}
	select {
	case <-done:
	default:
	}
}

func locateShared(explicit string) (string, error) {
	if explicit != "" {
		return cleanShared(explicit)
	}

	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find launcher location: %w", err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)

	candidates := []string{
		filepath.Join(dir, "shared"),
		filepath.Join(dir, "Shared"),
	}

	current := dir
	for i := 0; i < 7; i++ {
		candidates = append(candidates,
			filepath.Join(current, "shared"),
			filepath.Join(current, "Shared"),
		)
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "shared"),
			filepath.Join(wd, "Shared"),
		)
	}

	seen := map[string]bool{}
	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		if _, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("could not find shared/index.html near the launcher; keep the launcher and shared folder in the USB layout")
}

func cleanShared(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve shared path: %w", err)
	}
	if _, err := os.Stat(filepath.Join(abs, "index.html")); err != nil {
		return "", fmt.Errorf("shared application is incomplete at %s: %w", abs, err)
	}
	return abs, nil
}

func validatePayload(shared string) error {
	required := []string{
		"index.html",
		"app.js",
		"sherpa-onnx-tts.worker.js",
		"sherpa-onnx-tts.js",
	}
	for _, name := range required {
		if _, err := os.Stat(filepath.Join(shared, name)); err != nil {
			return fmt.Errorf("missing %s in shared application; run the builder first", name)
		}
	}

	wasmMatches, _ := filepath.Glob(filepath.Join(shared, "*.wasm"))
	dataMatches, _ := filepath.Glob(filepath.Join(shared, "*.data"))
	if len(wasmMatches) == 0 || len(dataMatches) == 0 {
		return fmt.Errorf("the generated Sherpa WASM payload is missing; run scripts/build_all.sh or the GitHub Actions builder")
	}
	return nil
}

func fingerprint(shared string) (string, error) {
	h := sha256.New()
	for _, name := range []string{"index.html", "app.js"} {
		f, err := os.Open(filepath.Join(shared, name))
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(h, f)
		closeErr := f.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

func findExistingServer(shared string) (string, bool) {
	fp, err := fingerprint(shared)
	if err != nil {
		return "", false
	}
	client := http.Client{Timeout: 600 * time.Millisecond}
	resp, err := client.Get("http://" + preferredAddr + "/health")
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128))
	if err != nil {
		return "", false
	}
	if strings.TrimSpace(string(body)) == "readaloud:"+fp {
		return "http://" + preferredAddr + "/?edition=" + editionID + "&build=" + fp, true
	}
	return "", false
}

func validHost(host string) bool {
	host = strings.ToLower(host)
	return strings.HasPrefix(host, "127.0.0.1:") ||
		strings.HasPrefix(host, "localhost:") ||
		host == "127.0.0.1" || host == "localhost"
}

func setHeaders(w http.ResponseWriter, path string) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".wasm":
		w.Header().Set("Content-Type", "application/wasm")
	case ".data", ".onnx", ".bin":
		w.Header().Set("Content-Type", "application/octet-stream")
	case ".js", ".mjs":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	default:
		if ext != "" {
			if t := mime.TypeByExtension(ext); t != "" {
				w.Header().Set("Content-Type", t)
			}
		}
	}

	// These permit a future threaded WASM build while remaining harmless for
	// the initial single-threaded version.
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")

	if ext == ".wasm" || ext == ".data" || ext == ".onnx" || ext == ".js" {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func writeOpenMe(shared, url string) error {
	path := filepath.Join(shared, "OPEN-THIS-ADDRESS.txt")
	return os.WriteFile(path, []byte(url+"\n"), 0o600)
}

func newLogger() (*log.Logger, func()) {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	dir = filepath.Join(dir, "readaloud-portable-"+editionID)
	_ = os.MkdirAll(dir, 0o700)
	f, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return log.New(os.Stderr, "readaloud: ", log.LstdFlags), func() {}
	}
	return log.New(f, "readaloud: ", log.LstdFlags), func() { _ = f.Close() }
}

func fatal(logger *log.Logger, err error) {
	logger.Printf("fatal: %v", err)
	message := appName + " could not start.\n\n" + err.Error()
	switch runtime.GOOS {
	case "windows":
		temp := filepath.Join(os.TempDir(), "ReadAloud-Error.txt")
		_ = os.WriteFile(temp, []byte(message+"\n"), 0o600)
		_ = exec.Command("notepad.exe", temp).Start()
	case "darwin":
		script := fmt.Sprintf(`display alert %q message %q as critical`, appName, err.Error())
		_ = exec.Command("osascript", "-e", script).Run()
	default:
		fmt.Fprintln(os.Stderr, message)
	}
	os.Exit(1)
}
