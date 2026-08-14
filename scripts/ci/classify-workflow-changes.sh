#!/usr/bin/env bash

set -euo pipefail

# Classify changed paths for GitHub Actions without adding a third-party action.
# Unknown events, unreadable diffs, and explicit/manual runs intentionally fall
# back to every check so a routing failure can never weaken validation.

all=false
quality=false
unit=false
e2e=false
build=false
duplication=false
mutation=false
dependency=false
codeql=false
semgrep=false
semgrep_full=false
security_tools=false
codex_security=false

set_all() {
  all=true
  quality=true
  unit=true
  e2e=true
  build=true
  duplication=true
  mutation=true
  dependency=true
  codeql=true
  semgrep=true
  semgrep_full=true
  security_tools=true
  codex_security=true
}

classify_path() {
  local path="$1"

  case "$path" in
    scripts/ci/classify-workflow-changes.sh | .github/workflows/ci.yaml)
      # Routing changes must exercise every route they can affect.
      set_all
      ;;
    README.md | CHANGELOG.md | CODE_OF_CONDUCT.md | CONTRIBUTING.md | SUPPORT.md | LICENSE | docs/* | test/README.md | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md)
      # Documentation cannot affect the app gates, but still receives the
      # lightweight Semgrep secrets ruleset.
      semgrep=true
      ;;
    test/__screenshots__/*)
      # Binary visual baselines are not exercised by the repository CI profile.
      ;;
    .gitmodules | packages/core)
      quality=true
      unit=true
      e2e=true
      build=true
      mutation=true
      dependency=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .node-version)
      quality=true
      unit=true
      e2e=true
      build=true
      mutation=true
      dependency=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    src/*)
      quality=true
      unit=true
      e2e=true
      build=true
      duplication=true
      mutation=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    functions/* | tooling/*)
      quality=true
      unit=true
      e2e=true
      build=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    public/* | index.html)
      quality=true
      unit=true
      e2e=true
      build=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    test/unit/* | test/setup.ts | vitest.config.ts | tsconfig.test.json)
      quality=true
      unit=true
      mutation=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    test/e2e/* | test/lib/* | test/tsconfig.playwright.json | playwright.config.ts)
      quality=true
      e2e=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    scripts/test/*)
      quality=true
      unit=true
      e2e=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    scripts/build/* | scripts/release/*)
      quality=true
      unit=true
      build=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    scripts/ci/*)
      quality=true
      unit=true
      duplication=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    scripts/security/*)
      quality=true
      unit=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    .github/workflows/security.yaml)
      unit=true
      dependency=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    .github/workflows/* | .github/actions/*)
      unit=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    .github/codex-security/* | .github/SECURITY.md | .github/dependabot.yaml)
      unit=true
      dependency=true
      codeql=true
      semgrep=true
      semgrep_full=true
      security_tools=true
      codex_security=true
      ;;
    biome.json | knip.json | tsconfig.json)
      quality=true
      unit=true
      build=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    vite.config.ts)
      quality=true
      unit=true
      e2e=true
      build=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    stryker.conf.json | stryker.conf.fast.json)
      quality=true
      unit=true
      mutation=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    .nose-baseline.json | nose.toml)
      quality=true
      unit=true
      duplication=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    wrangler.toml)
      unit=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    .gitattributes | .gitignore)
      semgrep=true
      ;;
    .githooks/*)
      quality=true
      unit=true
      codeql=true
      semgrep=true
      semgrep_full=true
      codex_security=true
      ;;
    *)
      echo "Unknown changed path; enabling all checks: $path" >&2
      set_all
      ;;
  esac
}

changed_files=()
mode="${1:-event}"

if [[ "$mode" == "--files-from-stdin" ]]; then
  mapfile -t changed_files
elif [[ "$mode" != "event" ]]; then
  echo "Unsupported classifier mode: $mode" >&2
  set_all
else
  event_name="${GITHUB_EVENT_NAME:-unknown}"
  case "$event_name" in
    workflow_dispatch | schedule | repository_dispatch)
      set_all
      ;;
    pull_request | push | merge_group)
      event_path="${GITHUB_EVENT_PATH:-}"
      if [[ -z "$event_path" || ! -r "$event_path" ]]; then
        echo "GitHub event payload is unavailable; enabling all checks." >&2
        set_all
      else
        case "$event_name" in
          pull_request)
            base_sha="$(jq -er '.pull_request.base.sha' "$event_path" 2>/dev/null || true)"
            head_sha="${GITHUB_SHA:-}"
            ;;
          push)
            base_sha="$(jq -er '.before' "$event_path" 2>/dev/null || true)"
            head_sha="$(jq -er '.after' "$event_path" 2>/dev/null || true)"
            ;;
          merge_group)
            base_sha="$(jq -er '.merge_group.base_sha' "$event_path" 2>/dev/null || true)"
            head_sha="$(jq -er '.merge_group.head_sha' "$event_path" 2>/dev/null || true)"
            ;;
        esac

        if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ || ! "$head_sha" =~ ^[0-9a-f]{40}$ || "$base_sha" == "0000000000000000000000000000000000000000" ]]; then
          echo "GitHub diff boundary is invalid; enabling all checks." >&2
          set_all
        else
          diff_file="$(mktemp)"
          trap 'rm -f "$diff_file"' EXIT
          if git diff --no-renames --name-only -z "$base_sha" "$head_sha" >"$diff_file"; then
            mapfile -d '' -t changed_files <"$diff_file"
            if [[ "${#changed_files[@]}" -eq 0 ]]; then
              echo "GitHub diff is empty; enabling all checks." >&2
              set_all
            fi
          else
            echo "Unable to calculate GitHub diff; enabling all checks." >&2
            set_all
          fi
        fi
      fi
      ;;
    *)
      echo "Unsupported GitHub event; enabling all checks: $event_name" >&2
      set_all
      ;;
  esac
fi

if [[ "$all" != true ]]; then
  if [[ "${#changed_files[@]}" -eq 0 ]]; then
    echo "No changed paths supplied; enabling all checks." >&2
    set_all
  else
    for path in "${changed_files[@]}"; do
      classify_path "$path"
      [[ "$all" == true ]] && break
    done
  fi
fi

emit() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

emit all "$all"
emit quality "$quality"
emit unit "$unit"
emit e2e "$e2e"
emit build "$build"
emit duplication "$duplication"
emit mutation "$mutation"
emit dependency "$dependency"
emit codeql "$codeql"
emit semgrep "$semgrep"
emit semgrep_full "$semgrep_full"
emit security_tools "$security_tools"
emit codex_security "$codex_security"
