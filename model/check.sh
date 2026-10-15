#!/usr/bin/env bash
# Checks model/Access.tla with TLC: Access.cfg and Witness.cfg must hold, and
# every config in counterfactuals/ must fail the way its `expect:` line says.
# Uses java when it's on PATH, otherwise a pinned JRE image in Docker.
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
JRE_IMAGE=eclipse-temurin:21.0.8_9-jre@sha256:66bb900643426ad01996d25bada7d56751913f9cec3b827fcb715d2ec9a0fbfc

here=$(cd "$(dirname "$0")" && pwd)
cache=${XDG_CACHE_HOME:-$HOME/.cache}/vboard-model
jar=$cache/tla2tools-$TLA_VERSION.jar

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

if [[ ! -f $jar || $(sha256 "$jar") != "$TLA_SHA256" ]]; then
  mkdir -p "$cache"
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  if [[ $(sha256 "$jar.part") != "$TLA_SHA256" ]]; then
    rm -f "$jar.part"
    echo "error: tla2tools.jar $TLA_VERSION doesn't match its pinned sha256" >&2
    exit 1
  fi
  mv "$jar.part" "$jar"
fi

# tlc <cfg> <workers>: run TLC on Access with that config, from the model directory.
tlc() {
  local args=(tlc2.TLC -workers "$2" -config "$1")
  if command -v java >/dev/null; then
    (cd "$here" && java -XX:+UseParallelGC -cp "$jar" "${args[@]}" -metadir "$logs/states" Access)
  else
    docker run --rm -u "$(id -u):$(id -g)" -v "$here:/model:ro" -v "$jar:/tla/tla2tools.jar:ro" -w /model \
      "$JRE_IMAGE" java -XX:+UseParallelGC -cp /tla/tla2tools.jar "${args[@]}" -metadir /tmp/states Access
  fi
}

configs=(Access.cfg Witness.cfg)
for cfg in "$here"/counterfactuals/*.cfg; do configs+=("counterfactuals/${cfg##*/}"); done
width=0
for cfg in "${configs[@]}"; do (( ${#cfg} > width )) && width=${#cfg}; done

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
failed=0
for cfg in "${configs[@]}"; do
  expect=$(sed -n 's/^\\\* expect: //p' "$here/$cfg")
  # TLC registers are per worker, so the witness check runs on one.
  workers=auto
  [[ $expect == used || $expect == unused ]] && workers=1
  log=$logs/${cfg//\//_}.log
  start=$SECONDS
  tlc "$cfg" "$workers" >"$log" 2>&1 || true
  took=$((SECONDS - start))s
  states=$(sed -n 's/.* \([0-9][0-9]*\) distinct states found.*/\1/p' "$log" | tail -1)

  clean=$(grep -c 'Model checking completed. No error has been found.' "$log" || true)
  case $expect in
    ok) ok=$clean; result=holds ;;
    used) ok=$(grep -c 'Invariant Unused is violated' "$log" || true); result="every grant is used" ;;
    unused) ok=$clean; result="fails  a grant is never used" ;;
    "invariant "*) ok=$(grep -c "Invariant ${expect#invariant } is violated" "$log" || true); result="fails  ${expect#invariant }" ;;
    liveness) ok=$(grep -c 'Temporal properties were violated' "$log" || true); result="fails  liveness" ;;
    *) echo "error: $cfg has no expect: line" >&2; exit 2 ;;
  esac

  if [[ $ok -gt 0 ]]; then
    printf "%-${width}s  %s  (%s states, %s)\n" "$cfg" "$result" "${states:-0}" "$took"
  else
    failed=1
    printf "%-${width}s  expected %s, TLC said:\n" "$cfg" "$expect"
    grep -E '^(Error|Invariant|Model checking|Temporal|Deadlock)' "$log" | head -5 | sed 's/^/    /'
  fi
done

if [[ $failed -ne 0 ]]; then
  echo "error: the model doesn't check out; rerun one config with TLC to see its trace" >&2
  exit 1
fi
