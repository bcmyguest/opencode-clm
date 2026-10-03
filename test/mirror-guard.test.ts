// Adapted from pi-clm src/__tests__/mirror-guard.test.ts (MIT, Copyright 2026 Emanuel Casco).

import { describe, expect, test } from "bun:test";

import { classifyMirrorToolCall } from "../src/mirror-guard.ts";

const MIRROR = "/tmp/clm-test/LIVE_CONTEXT.md";
const MIRROR_DIR = "/tmp/clm-test";
const CWD = "/tmp/project";

function bash(command: string) {
	return classifyMirrorToolCall("bash", { command }, CWD, MIRROR);
}

describe("mirror tool-call classification", () => {
	test("edit and write tools targeting the mirror are writes", () => {
		expect(classifyMirrorToolCall("write", { filePath: MIRROR, content: "x" }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("edit", { filePath: MIRROR, oldString: "a", newString: "b" }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("edit", { filePath: "/tmp/project/src/main.ts" }, CWD, MIRROR)).toBe("none");
	});

	test("relative and @-prefixed paths resolve against cwd", () => {
		expect(classifyMirrorToolCall("edit", { filePath: "../clm-test/LIVE_CONTEXT.md" }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("write", { filePath: `@${MIRROR}` }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("edit", { filePath: "LIVE_CONTEXT.md" }, CWD, MIRROR)).toBe("none");
	});

	test("apply_patch touching the mirror is a write", () => {
		const patch = (header: string) => ["*** Begin Patch", header, "@@", "-old", "+new", "*** End Patch"].join("\n");
		expect(classifyMirrorToolCall("apply_patch", { patchText: patch(`*** Update File: ${MIRROR}`) }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("apply_patch", { patchText: patch(`*** Delete File: ${MIRROR}`) }, CWD, MIRROR)).toBe("write");
		const moved = patch(`*** Update File: src/a.ts\n*** Move to: ${MIRROR}`);
		expect(classifyMirrorToolCall("apply_patch", { patchText: moved }, CWD, MIRROR)).toBe("write");
		expect(classifyMirrorToolCall("apply_patch", { patchText: patch("*** Update File: src/a.ts") }, CWD, MIRROR)).toBe("none");
		expect(classifyMirrorToolCall("apply_patch", {}, CWD, MIRROR)).toBe("none");
	});

	test("the read tool on the mirror is a read", () => {
		expect(classifyMirrorToolCall("read", { filePath: MIRROR }, CWD, MIRROR)).toBe("read");
		expect(classifyMirrorToolCall("read", { filePath: "/tmp/project/README.md" }, CWD, MIRROR)).toBe("none");
	});

	test("the skill's header discovery command is a read", () => {
		const discovery = [
			`LIVE_CTX="${MIRROR}" python3 - <<'PY'`,
			"import os, re",
			"from pathlib import Path",
			"",
			'lines = Path(os.environ["LIVE_CTX"]).read_text().splitlines()',
			'meta = re.fullmatch(r"\\[\\[LIVE_CONTEXT .* document=([a-f0-9]{64}) baseline=[a-f0-9]{64}\\]\\]", lines[0])',
			"if not meta:",
			'    raise SystemExit("invalid live-context metadata")',
			"doc = meta.group(1)",
			"print(lines[0])",
			"for line in lines[1:]:",
			'    if line.startswith(f"[[CTX_TURN document={doc} "):',
			"        print(line)",
			"PY",
		].join("\n");
		expect(bash(discovery)).toBe("read");
	});

	test("the skill's replacement recipe is a write", () => {
		const edit = [
			"python3 - <<'PY'",
			"from pathlib import Path",
			"import re",
			"",
			`p = Path("${MIRROR}")`,
			"s = p.read_text()",
			'turn_id = "2-abc123def456"',
			'summary = "[summary: findings]"',
			"s, count = re.subn(pattern, lambda m: m.group(1) + summary, s, count=1, flags=re.M | re.S)",
			"if count != 1:",
			'    raise SystemExit(f"turn not found: {turn_id}")',
			"",
			"p.write_text(s)",
			"PY",
		].join("\n");
		expect(bash(edit)).toBe("write");
	});

	test("shell write operators targeting the mirror are writes", () => {
		expect(bash(`cat /tmp/replacement.md > ${MIRROR}`)).toBe("write");
		expect(bash(`printf 'x' | tee ${MIRROR}`)).toBe("write");
		expect(bash(`sed -E -i '' 's/old/new/' ${MIRROR}`)).toBe("write");
		expect(bash(`rm ${MIRROR}`)).toBe("write");
		expect(bash(`mv ${MIRROR} /tmp/elsewhere.md`)).toBe("write");
	});

	test("further write commands naming the mirror or its directory are writes", () => {
		expect(bash(`install -m 600 /tmp/new.md ${MIRROR}`)).toBe("write");
		expect(bash(`ln -sf /tmp/other.md ${MIRROR}`)).toBe("write");
		expect(bash(`rsync /tmp/new.md ${MIRROR}`)).toBe("write");
		expect(bash(`ex -sc '%s/a/b/|x' ${MIRROR}`)).toBe("write");
		expect(bash(`node -e 'require("fs").writeFileSync("${MIRROR}", "x")'`)).toBe("write");
		expect(bash(`node -e 'fs.writeFile("${MIRROR}", "x", cb)'`)).toBe("write");
		expect(bash(`python3 -c 'open("${MIRROR}", "w").write("x")'`)).toBe("write");
		expect(bash(`python3 -c 'f = open("${MIRROR}", mode="a")'`)).toBe("write");
		expect(bash(`python3 -c 'import pathlib; pathlib.Path("${MIRROR}").open("w")'`)).toBe("write");
		expect(bash(`cd ${MIRROR_DIR} && cp /tmp/new.md ./CTX.md`)).toBe("write");
		expect(bash(`cp /tmp/new.md "${MIRROR_DIR}"`)).toBe("write");
	});

	test("the mirror directory must match a whole path component", () => {
		expect(bash(`cp a ${MIRROR_DIR}2/x`)).toBe("none");
		expect(bash(`ls ${MIRROR_DIR}`)).toBe("read");
	});

	test("/dev/null and fd redirections are not writes", () => {
		expect(bash(`grep x ${MIRROR} 2>/dev/null`)).toBe("read");
		expect(bash(`head ${MIRROR} >&2`)).toBe("read");
		expect(bash(`wc -l ${MIRROR} > /dev/null 2>&1`)).toBe("read");
		expect(bash(`cat ${MIRROR} &>/dev/null`)).toBe("read");
		expect(bash(`cat ${MIRROR} 2>&1 > /tmp/copy.md`)).toBe("write");
	});

	test("patch and multiedit are not OpenCode 1.18 tools and are ignored", () => {
		expect(classifyMirrorToolCall("patch", { filePath: MIRROR }, CWD, MIRROR)).toBe("none");
		expect(classifyMirrorToolCall("multiedit", { filePath: MIRROR }, CWD, MIRROR)).toBe("none");
	});

	test("plain inspection of the mirror is a read", () => {
		expect(bash(`grep 'CTX_TURN' ${MIRROR}`)).toBe("read");
		expect(bash(`head -n 3 ${MIRROR}`)).toBe("read");
		expect(bash(`wc -l ${MIRROR}`)).toBe("read");
	});

	test("commands that do not reference the mirror are ignored", () => {
		expect(bash("cat notes.md > summary.md")).toBe("none");
		expect(bash("python3 script.py")).toBe("none");
		expect(classifyMirrorToolCall("bash", {}, CWD, MIRROR)).toBe("none");
		expect(classifyMirrorToolCall("glob", { pattern: MIRROR }, CWD, MIRROR)).toBe("none");
	});
});
