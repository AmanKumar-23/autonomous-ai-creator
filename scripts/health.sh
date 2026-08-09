#!/usr/bin/env bash
# One command that answers "is this on track?".
#
#   ./scripts/health.sh
#
# Checks the five things that can independently lose the competition:
#   1. the endpoints the evaluator polls
#   2. whether the cron is actually firing
#   3. what the cycles are deciding (publishing vs failing silently)
#   4. whether the repo is in a clean state to be evaluated
#   5. whether the live site is actually serving what the repo contains
#
# Read-only. Safe to run at any time, including mid-evaluation.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" || exit 1

URL="${1:-https://autonomous-ai-creator-theta.vercel.app}"
REPO="AmanKumar-23/autonomous-ai-creator"
WARN=0

green() { printf '  \033[32m%-4s\033[0m %s\n' "OK" "$1"; }
bad()   { printf '  \033[31m%-4s\033[0m %s\n' "FAIL" "$1"; WARN=$((WARN+1)); }
note()  { printf '  \033[33m%-4s\033[0m %s\n' "!" "$1"; WARN=$((WARN+1)); }
info()  { printf '       %s\n' "$1"; }

echo
echo "═══ 1. THE ENDPOINTS THE EVALUATOR POLLS ═══"
FEED="$(curl -s -o /tmp/h.$$ -w '%{http_code}' --max-time 20 "$URL/api/agent/feed?agentId=health")"
BODY="$(cat /tmp/h.$$ 2>/dev/null)"; rm -f /tmp/h.$$
if [ "$FEED" = "200" ] && printf '%s' "$BODY" | grep -q '"posts"'; then
  green "feed returns 200 with a posts array"
else
  bad "feed returned HTTP $FEED — this alone is an eligibility failure"
fi

VIEW="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/")"
[ "$VIEW" = "200" ] && green "viewer page returns 200" || bad "viewer page returned HTTP $VIEW"

REJ="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/rejections")"
[ "$REJ" = "200" ] && green "rejection log returns 200" || note "rejection log returned HTTP $REJ"

BADREQ="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$URL/api/agent/init" \
  -H 'Content-Type: application/json' -d '{"persona":{"name":"x"}}')"
[ "$BADREQ" = "400" ] && green "init rejects malformed input with 400" || note "init returned $BADREQ for bad input (want 400)"

echo
echo "═══ 2. IS THE CRON ACTUALLY FIRING? ═══"
if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
  RUNS="$(gh run list --workflow="agent cycle" --limit 8 \
    --json event,conclusion,createdAt -q '.[] | "\(.createdAt) \(.event) \(.conclusion)"' 2>/dev/null)"
  SCHED="$(printf '%s\n' "$RUNS" | grep -c schedule || true)"
  FAILED="$(printf '%s\n' "$RUNS" | grep -c failure || true)"
  LAST="$(printf '%s\n' "$RUNS" | head -1 | cut -c1-16)"

  [ "$SCHED" -gt 0 ] && green "$SCHED of the last 8 runs were scheduled (not manual)" \
                     || bad "no scheduled runs — the cron is not firing"
  [ "$FAILED" -eq 0 ] && green "no failed workflow runs" || note "$FAILED workflow run(s) failed"
  info "most recent run: ${LAST}Z"

  # Slot spacing: GitHub drops scheduled slots under load.
  GAP="$(printf '%s\n' "$RUNS" | grep schedule | head -2 | cut -d' ' -f1 | \
    python3 -c "
import sys,datetime
ts=[l.strip() for l in sys.stdin if l.strip()]
if len(ts)==2:
    a=datetime.datetime.fromisoformat(ts[0].replace('Z','+00:00'))
    b=datetime.datetime.fromisoformat(ts[1].replace('Z','+00:00'))
    print(round(abs((a-b).total_seconds())/3600,1))
" 2>/dev/null)"
  [ -n "$GAP" ] && info "gap between last two scheduled runs: ${GAP}h (cron asks for 2h; GitHub often delays)"
else
  note "gh not authenticated — skipping workflow checks"
fi

echo
echo "═══ 3. WHAT ARE THE CYCLES DECIDING? ═══"
CYCLES="$(curl -s --max-time 20 "https://api.github.com/repos/$REPO/contents/data/cycles.json" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
      const j=JSON.parse(d); console.log(Buffer.from(j.content,'base64').toString('utf8'));
    }catch(e){console.log('{\"cycles\":[]}')}})" 2>/dev/null)"

printf '%s' "$CYCLES" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  let cycles=[]; try { cycles=JSON.parse(d).cycles||[] } catch(e){}
  if (cycles.length===0){ console.log('       no cycles recorded yet (expected before init)'); process.exit(0) }
  const by={}; cycles.forEach(c=>by[c.status]=(by[c.status]||0)+1);
  Object.entries(by).forEach(([k,v])=>console.log('       '+k+': '+v));
  const pub=by.published||0, failed=by.failed||0;
  if (failed>0 && failed>=pub) console.log('       ^ more failures than publishes — investigate');
  const provs={}; cycles.filter(c=>c.provider).forEach(c=>provs[c.provider]=(provs[c.provider]||0)+1);
  if(Object.keys(provs).length) console.log('       providers: '+Object.entries(provs).map(([k,v])=>k+' x'+v).join(', '));
  const last=cycles[0];
  if(last) console.log('       latest: ['+last.status+'] '+String(last.reason).slice(0,90));
})"

echo
echo "═══ 4. IS THE REPO IN A CLEAN STATE TO BE EVALUATED? ═══"
STATE="$(curl -s --max-time 20 "https://api.github.com/repos/$REPO/contents/data/state.json" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
      console.log(Buffer.from(JSON.parse(d).content,'base64').toString('utf8'))}catch(e){console.log('{}')}})" 2>/dev/null)"
INIT="$(printf '%s' "$STATE" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).initialized" 2>/dev/null)"

if [ "$INIT" = "true" ]; then
  note "agent is INITIALIZED — fine during evaluation, but reset before submitting"
  info "persona: $(printf '%s' "$STATE" | node -p "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));(s.persona&&s.persona.name+' / '+s.persona.domain)||'?'" 2>/dev/null)"
else
  green "agent is uninitialized — the evaluator's init will be the first"
fi

if [ -z "$(git status --porcelain)" ]; then
  green "working tree clean"
else
  note "uncommitted local changes: $(git status --porcelain | wc -l | tr -d ' ') file(s)"
fi

git fetch -q origin main 2>/dev/null
BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
[ "$BEHIND" = "0" ] && green "local is up to date with origin/main" \
                    || note "local is $BEHIND commit(s) behind origin/main — run: git pull"

if git grep -qE 'gsk_[A-Za-z0-9]{20}|ck_live_[A-Za-z0-9]{20}|AIza[A-Za-z0-9_-]{25}' -- . 2>/dev/null; then
  bad "possible API key committed to the repo — rotate it now"
else
  green "no key material tracked in the repo"
fi

echo
echo "═══ 5. DOES THE LIVE SITE MATCH THE REPO? ═══"
# The failure this exists for: a commit lands correctly, Vercel creates no
# deployment for it, and production keeps serving the previous build. The repo is
# right, the endpoints answer 200, every workflow run is green — and the feed
# never changes. Checking each side separately cannot see it; only comparing can.

fetch_committed() {  # fetch_committed <path> -> file contents, or empty
  curl -s --max-time 20 "https://api.github.com/repos/$REPO/contents/$1" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
        process.stdout.write(Buffer.from(JSON.parse(d).content,'base64').toString('utf8'))
      }catch(e){process.stdout.write('')}})" 2>/dev/null
}

REPO_POSTS="$(fetch_committed data/posts.json)"
REPO_STATE="$(fetch_committed data/state.json)"
LIVE_FEED="$(curl -s --max-time 20 "$URL/api/agent/feed")"
LIVE_HOME="$(curl -s --max-time 20 "$URL/")"

if [ -z "$REPO_POSTS" ] || [ -z "$LIVE_FEED" ]; then
  note "could not fetch both sides — skipping the comparison"
else
  read -r REPO_N REPO_ID <<< "$(printf '%s' "$REPO_POSTS" | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
      const p=(JSON.parse(d).posts||[]).slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      console.log(p.length+' '+(p[0]?p[0].id:'-'))}catch(e){console.log('? ?')}})")"
  read -r LIVE_N LIVE_ID <<< "$(printf '%s' "$LIVE_FEED" | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
      const p=JSON.parse(d).posts||[];
      console.log(p.length+' '+(p[0]?p[0].id:'-'))}catch(e){console.log('? ?')}})")"

  REPO_INIT="$(printf '%s' "$REPO_STATE" | node -p "try{JSON.parse(require('fs').readFileSync(0,'utf8')).initialized===true}catch(e){'?'}" 2>/dev/null)"
  # The viewer is the only surface that reveals the deployed init state.
  if printf '%s' "$LIVE_HOME" | grep -q "Waiting for its first assignment"; then
    LIVE_INIT="false"
  else
    LIVE_INIT="true"
  fi

  DRIFT=0
  if [ "$REPO_N" = "$LIVE_N" ]; then
    green "post count agrees (repo $REPO_N = live $LIVE_N)"
  else
    bad "POST COUNT DRIFT — repo has $REPO_N, live serves $LIVE_N"; DRIFT=1
  fi

  if [ "$REPO_ID" = "$LIVE_ID" ]; then
    green "newest post id agrees"
  else
    bad "NEWEST POST DRIFT — repo ${REPO_ID:0:8}, live ${LIVE_ID:0:8}"; DRIFT=1
  fi

  if [ "$REPO_INIT" = "$LIVE_INIT" ]; then
    green "initialized state agrees (both $REPO_INIT)"
  else
    bad "INIT STATE DRIFT — repo says $REPO_INIT, live says $LIVE_INIT"; DRIFT=1
  fi

  if [ "$DRIFT" -ne 0 ]; then
    echo
    echo "  ── The repo is ahead of what production is serving. ──"
    echo "  Vercel most likely skipped a deployment. Force a rebuild with:"
    echo
    echo "      git commit --allow-empty -m 'Trigger a Vercel rebuild' && git push"
    echo
    echo "  Then re-run this script. If it still drifts, check the Vercel"
    echo "  dashboard for a failed or queued build."
  fi
fi

echo
echo "═══════════════════════════════════════════"
if [ "$WARN" -eq 0 ]; then
  echo "  Everything is on track."
else
  echo "  $WARN item(s) need a look — see the FAIL/! lines above."
fi
echo
