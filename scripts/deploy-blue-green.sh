#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🔄 Blue-Green Deploy Script for Mastra Self-Healing
#  
#  Procedura:
#  1. Buduje kod w STAGING slocie
#  2. Uruchamia STAGING na zapasowym porcie
#  3. Czeka na health-check (max 60s)
#  4. Jeśli OK → swap (STAGING staje się LIVE)
#  5. Jeśli FAIL → rollback (kill staging, live bez zmian)
#
#  Użycie:
#    bash scripts/deploy-blue-green.sh              # Pełny deploy
#    bash scripts/deploy-blue-green.sh --dry-run    # Tylko build+health, bez swap
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/deploy.config.json"
DEPLOY_DIR="/projekty/mastra-agentic-environment/.deploy"
DRY_RUN="${1:-}"

# ── Colors ──
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── Load nvm ──
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use --silent 22 >/dev/null 2>&1 || true

# ── Helpers ──
log_info()  { echo -e "${CYAN}[DEPLOY]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[DEPLOY ✅]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[DEPLOY ⚠️]${NC} $1"; }
log_error() { echo -e "${RED}[DEPLOY ❌]${NC} $1"; }

timestamp() { date '+%Y-%m-%d_%H-%M-%S'; }

# ── Parse config ──
LIVE_DIR=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['A']['dir'])")
STAGING_DIR=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['B']['dir'])")
LIVE_PORT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['A']['port'])")
STAGING_PORT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['slots']['B']['port'])")
HEALTH_TIMEOUT=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['healthCheck']['timeoutMs'] // 1000)")
HEALTH_INTERVAL=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['healthCheck']['intervalMs'] // 1000)")

# ── Ensure dirs ──
mkdir -p "$DEPLOY_DIR/logs"

LOG_FILE="$DEPLOY_DIR/logs/deploy-$(timestamp).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log_info "═══════════════════════════════════════"
log_info "  Blue-Green Deploy Started"
log_info "  Live:    $LIVE_DIR (port $LIVE_PORT)"
log_info "  Staging: $STAGING_DIR (port $STAGING_PORT)"
log_info "  Mode:    ${DRY_RUN:-production}"
log_info "  Log:     $LOG_FILE"
log_info "═══════════════════════════════════════"

# ══════════════════════════════════════════════════════════════════
#  Step 1: Prepare STAGING directory
# ══════════════════════════════════════════════════════════════════

log_info "Step 1: Preparing staging directory..."

if [ ! -d "$STAGING_DIR" ]; then
  log_info "Creating staging via rsync (first run)..."
  mkdir -p "$STAGING_DIR"
fi

rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.mastra' \
  --exclude='.git' \
  --exclude='mastra.duckdb' \
  --exclude='mastra.duckdb.wal' \
  --exclude='.env' \
  --exclude='.deploy' \
  "$LIVE_DIR/" "$STAGING_DIR/"

# Zapisz wersję (SHA) z live repo jako marker — bez kopiowania .git
LIVE_SHA=$(cd "$LIVE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
echo "$LIVE_SHA" > "$STAGING_DIR/.deploy-version"

# Copy .env if not present
if [ ! -f "$STAGING_DIR/.env" ] && [ -f "$LIVE_DIR/.env" ]; then
  cp "$LIVE_DIR/.env" "$STAGING_DIR/.env"
fi

log_ok "Staging synced from live (version: $LIVE_SHA)"

# ══════════════════════════════════════════════════════════════════
#  Step 2: Install deps + Build in STAGING
# ══════════════════════════════════════════════════════════════════

log_info "Step 2: Building in staging..."

cd "$STAGING_DIR"

if [ ! -d "node_modules" ]; then
  log_info "Installing dependencies..."
  npm install --silent 2>&1 || pnpm install --silent 2>&1
fi

log_info "Running mastra build..."
npx mastra build 2>&1
BUILD_EXIT=$?

if [ $BUILD_EXIT -ne 0 ]; then
  log_error "Build FAILED (exit code $BUILD_EXIT). Aborting deploy."
  exit 1
fi

log_ok "Build successful"

# ══════════════════════════════════════════════════════════════════
#  Step 3: Start STAGING on alternate port
# ══════════════════════════════════════════════════════════════════

log_info "Step 3: Starting staging server on port $STAGING_PORT..."

# Kill any previous staging process
if [ -f "$DEPLOY_DIR/slot-b.pid" ]; then
  OLD_PID=$(cat "$DEPLOY_DIR/slot-b.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log_warn "Killing old staging process (PID $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

PORT=$STAGING_PORT DEPLOY_SLOT=B node .mastra/output/index.mjs &
STAGING_PID=$!
echo "$STAGING_PID" > "$DEPLOY_DIR/slot-b.pid"

log_info "Staging started with PID $STAGING_PID"

# ══════════════════════════════════════════════════════════════════
#  Step 4: Health check
#  Mastra ma wbudowany /health → {"success":true}
#  Nasz custom /deploy/health → {"status":"ok", "version": ...}
# ══════════════════════════════════════════════════════════════════

log_info "Step 4: Waiting for health check (max ${HEALTH_TIMEOUT}s)..."

# Używamy wbudowanego /health jako primary (pewniejszy)
HEALTH_URL="http://localhost:${STAGING_PORT}/health"
ELAPSED=0
HEALTHY=false

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))

  RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null || echo "")
  if [ -n "$RESPONSE" ]; then
    # Mastra wbudowany /health zwraca {"success":true}
    if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('success')==True or d.get('status')=='ok'" 2>/dev/null; then
      HEALTHY=true
      break
    fi
  fi

  log_info "Health check attempt ($ELAPSED/${HEALTH_TIMEOUT}s)..."
done

if [ "$HEALTHY" = true ]; then
  log_ok "Staging is healthy!"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

  # Spróbuj też nasz custom health dla pełnych danych
  CUSTOM_HEALTH=$(curl -sf "http://localhost:${STAGING_PORT}/deploy/health" 2>/dev/null || echo "")
  if [ -n "$CUSTOM_HEALTH" ]; then
    log_ok "Custom deploy health:"
    echo "$CUSTOM_HEALTH" | python3 -m json.tool 2>/dev/null || echo "$CUSTOM_HEALTH"
  fi
else
  log_error "Staging failed health check after ${HEALTH_TIMEOUT}s!"
  log_error "Killing staging process..."
  
  # Tylko kill staging — NIE revertujemy gita! To nie jest nasza wina.
  kill "$STAGING_PID" 2>/dev/null || true
  rm -f "$DEPLOY_DIR/slot-b.pid"

  log_error "STAGING FAILED. Live remains untouched on port $LIVE_PORT."
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
#  Step 5: Swap or dry-run report
# ══════════════════════════════════════════════════════════════════

if [ "$DRY_RUN" = "--dry-run" ]; then
  log_ok "DRY RUN: Staging verified healthy. Stopping staging process."
  kill "$STAGING_PID" 2>/dev/null || true
  rm -f "$DEPLOY_DIR/slot-b.pid"
  
  log_ok "═══════════════════════════════════════"
  log_ok "  DRY RUN COMPLETE — staging healthy"
  log_ok "  Version: $(cat "$STAGING_DIR/.deploy-version" 2>/dev/null || echo 'unknown')"
  log_ok "═══════════════════════════════════════"
  exit 0
fi

log_info "Step 5: Swap — staging becomes live..."

# Zapisz dane przed swapem
LIVE_VERSION=$(cd "$LIVE_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
STAGING_VERSION=$(cat "$STAGING_DIR/.deploy-version" 2>/dev/null || echo 'unknown')

log_info "Live version:    $LIVE_VERSION"
log_info "Staging version: $STAGING_VERSION"

# Staging działa na :4222. Żeby zamienić, musimy:
# 1. Zatrzymać live (:4111)
# 2. Uruchomić staging na :4111
# Ale to wymaga restartu terminala Mastra. Na razie zostawiamy staging na :4222.

log_warn "═══════════════════════════════════════"
log_warn "  Staging zweryfikowany i działa na :$STAGING_PORT"
log_warn "  Aby przełączyć na nowy kod:"
log_warn "  1. Zatrzymaj Mastra Studio (Ctrl+C w terminalu)"
log_warn "  2. Uruchom: cd $STAGING_DIR && pnpm dev"
log_warn "  Lub poczekaj na integrację z workflow (Etap 6b)"
log_warn "═══════════════════════════════════════"

log_ok "═══════════════════════════════════════"
log_ok "  DEPLOY VERIFICATION COMPLETE"
log_ok "  Staging healthy on :$STAGING_PORT"
log_ok "  Version: $STAGING_VERSION"
log_ok "  PID: $STAGING_PID"
log_ok "  Log: $LOG_FILE"
log_ok "═══════════════════════════════════════"
