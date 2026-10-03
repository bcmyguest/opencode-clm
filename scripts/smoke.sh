#!/usr/bin/env bash
# Local verification harness for opencode-clm. Runs offline; prompts no model.
#
#   1. npm pack --dry-run: the tarball holds exactly the shipped files.
#   2. opencode loads the plugin from file:// and its config hook registers /clm,
#      /clm-compact and the skills path (`opencode debug config`, `opencode debug skill`).
#   3. @opencode-ai/plugin (a dependency) resolution: from the repo's node_modules, from a
#      bare extracted tarball (expected not to load), from an offline `npm install` of the
#      tarball, and from opencode's own install of `opencode-clm@file:<tarball>`.
#
# Every opencode call runs with temp HOME and XDG_* dirs, so ~/.config/opencode and
# ~/.local/share/opencode stay untouched. npm runs offline against ~/.npm.
# Exit status is non-zero on any failure. --strict turns SKIP into FAIL.
set -euo pipefail

STRICT=0
[[ ${1:-} == --strict ]] && STRICT=1

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NPM_CACHE=${npm_config_cache:-$HOME/.npm}
TMP=$(mktemp -d -t opencode-clm-smoke.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
export npm_config_logs_dir=$TMP/npm-logs

FAILURES=0
PASSES=0
pass() { printf '  PASS %s\n' "$*"; PASSES=$((PASSES + 1)); }
fail() { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
EXPECTED_PASSES=20
# $1 = number of PASS checks the skipped step would have produced.
skip() {
	local n=$1; shift
	if ((STRICT)); then fail "(strict) $*"; else printf '  SKIP %s\n' "$*"; EXPECTED_PASSES=$((EXPECTED_PASSES - n)); fi
}

# Runs opencode in a sandbox rooted at $1; remaining arguments go to opencode.
oc() {
	local root=$1; shift
	mkdir -p "$root"/{home,cfg,data,state,cache}
	env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR \
		HOME="$root/home" XDG_CONFIG_HOME="$root/cfg" XDG_DATA_HOME="$root/data" \
		XDG_STATE_HOME="$root/state" XDG_CACHE_HOME="$root/cache" \
		npm_config_cache="$NPM_CACHE" npm_config_offline=true \
		OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
		OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_SHARE=1 \
		OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_CLAUDE_CODE=1 \
		timeout 90 opencode --print-logs --log-level DEBUG "$@"
}

# Writes a project whose opencode.json loads $2, then runs `debug config` and `debug skill`.
# Leaves $1/config.json, $1/skill.txt and $1/logs.txt.
load_plugin() {
	local root=$1 spec=$2 rc=0
	mkdir -p "$root/proj"
	printf '{"$schema":"https://opencode.ai/config.json","plugin":["%s"]}\n' "$spec" > "$root/proj/opencode.json"
	(cd "$root/proj" && oc "$root" debug config > "$root/config.json" 2> "$root/logs.txt") || rc=$?
	((rc == 0)) || fail "opencode debug config exited $rc"
	rc=0
	(cd "$root/proj" && oc "$root" debug skill > "$root/skill.txt" 2>> "$root/logs.txt") || rc=$?
	((rc == 0)) || fail "opencode debug skill exited $rc"
	cat "$root"/data/opencode/log/*.log >> "$root/logs.txt" 2> /dev/null || true
}

# Prints one "ok"/"missing" line per registration; exits 2 if config.json does not parse
# or lacks the plugin entry $3.
config_registrations() {
	node -e '
		const [file, skills, spec] = process.argv.slice(1);
		let c;
		try { c = JSON.parse(require("fs").readFileSync(file, "utf8")); }
		catch (e) { console.log(`unparsable ${file}: ${e.message}`); process.exit(2); }
		if (!(c.plugin ?? []).includes(spec)) { console.log(`plugin entry ${spec} absent from resolved config`); process.exit(2); }
		console.log(c.command?.clm ? "ok /clm" : "missing /clm");
		console.log(c.command?.["clm-compact"] ? "ok /clm-compact" : "missing /clm-compact");
		console.log((c.skills?.paths ?? []).includes(skills) ? `ok skills.paths ${skills}` : `missing skills.paths ${skills}`);
	' "$1" "$2" "$3"
}

# Asserts the three registrations; $4 = "present" or "absent".
check_registrations() {
	local root=$1 skills=$2 spec=$3 want=$4 out rc=0 line oks=0
	out=$(config_registrations "$root/config.json" "$skills" "$spec") || rc=$?
	if ((rc != 0)); then fail "$out"; return; fi
	if (($(wc -l <<< "$out") != 3)); then fail "expected 3 registration lines, got: $out"; return; fi
	while IFS= read -r line; do [[ $line == ok* ]] && oks=$((oks + 1)); done <<< "$out"
	if [[ $want == present ]]; then
		while IFS= read -r line; do
			case $line in ok*) pass "${line#ok }" ;; *) fail "$line" ;; esac
		done <<< "$out"
	elif ((oks == 0)); then
		pass "config parses, plugin listed, nothing registered: plugin did not load, as expected"
	else
		fail "plugin registered $oks item(s) without @opencode-ai/plugin installed (unexpected)"
	fi
}

check_loaded() {
	local root=$1 skills=$2 spec=$3
	check_registrations "$root" "$skills" "$spec" present
	if grep -q 'clm-context' "$root/skill.txt"; then pass "debug skill lists clm-context"; else fail "debug skill omits clm-context"; fi
	# opencode logs nothing when a plugin fails to load; this catches only other errors.
	if grep -q 'level=ERROR' "$root/logs.txt"; then
		fail "ERROR lines in opencode logs:"; grep 'level=ERROR' "$root/logs.txt" | head -5 | cut -c1-300
	else
		pass "no ERROR lines in logs"
	fi
}

echo "== 1. npm pack --dry-run"
PACK_JSON=$TMP/pack.json
(cd "$REPO" && npm pack --dry-run --json --offline) > "$PACK_JSON" 2> "$TMP/pack.err" ||
	{ fail "npm pack --dry-run:"; cat "$TMP/pack.err"; exit 1; }
if node -e '
	const [p] = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
	const files = p.files.map((f) => f.path).sort();
	const required = ["index.ts", "tui.ts", "skills/clm-context/SKILL.md", "steering/house-brief.md", "LICENSE", "NOTICE", "README.md", "CHANGELOG.md", "package.json"];
	const isSrc = (f) => /^src\/(panel\/|tui\/)?[^/]+\.ts$/.test(f) && !/\.test\.ts$/.test(f);
	const bad = required.filter((f) => !files.includes(f)).map((f) => `missing ${f}`);
	for (const dir of ["src/", "src/panel/", "src/tui/"]) if (!files.some((f) => isSrc(f) && f.startsWith(dir) && !f.slice(dir.length).includes("/"))) bad.push(`missing ${dir}*.ts`);
	for (const f of files) if (!required.includes(f) && !isSrc(f)) bad.push(`unexpected file shipped: ${f}`);
	console.log(`  ${p.name}@${p.version}: ${p.entryCount} files, ${p.size} B packed, ${p.unpackedSize} B unpacked`);
	for (const f of files) console.log(`    ${f}`);
	for (const b of bad) console.log(`  FAIL ${b}`);
	process.exit(bad.length ? 1 : 0);
' "$PACK_JSON"; then pass "file list (exact allowlist)"; else fail "file list"; fi

echo "== 2. plugin load from file://$REPO/index.ts"
load_plugin "$TMP/repo" "file://$REPO/index.ts"
check_loaded "$TMP/repo" "$REPO/skills" "file://$REPO/index.ts"

echo "== 3. @opencode-ai/plugin resolution (regular dependency)"
if v=$(node -p 'require(process.argv[1]).version' "$REPO/node_modules/@opencode-ai/plugin/package.json" 2> /dev/null); then
	pass "file:// load resolves the import from $REPO/node_modules (@opencode-ai/plugin $v)"
else
	fail "$REPO/node_modules/@opencode-ai/plugin absent: run bun install"
fi

mkdir -p "$TMP/pkg"
(cd "$REPO" && npm pack --offline --pack-destination "$TMP/pkg") > /dev/null 2> "$TMP/pack.err" ||
	{ fail "npm pack:"; cat "$TMP/pack.err"; exit 1; }
TGZS=("$TMP"/pkg/*.tgz)
TGZ=${TGZS[0]}

echo "-- 3a. extracted tarball, no node_modules (dependency absent)"
BARE=$TMP/bare/node_modules/opencode-clm
mkdir -p "$BARE" && tar -xzf "$TGZ" -C "$BARE" --strip-components=1
load_plugin "$TMP/bare" "file://$BARE/index.ts"
check_registrations "$TMP/bare" "$BARE/skills" "file://$BARE/index.ts" absent

echo "-- 3b. npm install --offline of the tarball"
mkdir -p "$TMP/inst" && echo '{"private":true}' > "$TMP/inst/package.json"
if (cd "$TMP/inst" && HOME="$TMP/inst-home" npm_config_cache="$NPM_CACHE" \
	npm install --offline --no-audit --no-fund --ignore-scripts "$TGZ" > "$TMP/npm.log" 2>&1); then
	dep=$(node -p 'require(process.argv[1]).version' "$TMP/inst/node_modules/@opencode-ai/plugin/package.json" 2> /dev/null || echo none)
	pass "npm install --offline (@opencode-ai/plugin: $dep)"
	SPEC="file://$TMP/inst/node_modules/opencode-clm/index.ts"
	load_plugin "$TMP/inst" "$SPEC"
	check_loaded "$TMP/inst" "$TMP/inst/node_modules/opencode-clm/skills" "$SPEC"
else
	skip 6 "npm install --offline failed (npm cache lacks a package?):"; tail -3 "$TMP/npm.log"
fi

echo "-- 3c. opencode installs opencode-clm@file:<tarball> itself"
SPEC="opencode-clm@file:$TGZ"
load_plugin "$TMP/ocinst" "$SPEC"
PKGDIR=$(find "$TMP/ocinst/cache/opencode/packages" -type d -path '*/node_modules/opencode-clm' 2> /dev/null | head -1 || true)
if [[ -n $PKGDIR ]]; then
	if [[ -e $(dirname "$PKGDIR")/@opencode-ai/plugin/package.json ]]; then pass "opencode installed @opencode-ai/plugin beside the plugin"; else fail "opencode did not install @opencode-ai/plugin"; fi
	check_loaded "$TMP/ocinst" "$PKGDIR/skills" "$SPEC"
else
	skip 6 "opencode did not install the tarball (offline npm cache miss?)"
fi

echo
((PASSES == EXPECTED_PASSES)) || fail "expected $EXPECTED_PASSES PASS lines, got $PASSES"
echo "smoke: $PASSES passed, $FAILURES failed"
((FAILURES == 0))
