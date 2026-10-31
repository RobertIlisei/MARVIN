/**
 * `vcsInvocations` — every git / gh / glab invocation in a shell command, with
 * the global options that do not change WHAT it does taken out of the way.
 *
 * The gate's integration patterns were written against `git push`; the
 * 2026-10-31 security audit found `git -C . push`, `glab -R o/r ci run` and
 * friends walked past every one of them. These tables are the contract.
 */

import { describe, expect, it } from "vitest";

import { vcsInvocations } from "../src/vcs-command";

const lines = (cmd: string) => vcsInvocations(cmd).map((i) => i.line);

describe("vcsInvocations — git global options are skipped", () => {
  it.each([
    ["git -C . push", "git push"],
    ["git -C /tmp/repo push origin main", "git push origin main"],
    ['git -C "dir with space" push', "git push"],
    ["git -c user.name=x push", "git push"],
    ["git -c a=b -c c=d push -u origin HEAD", "git push -u origin HEAD"],
    ["git --git-dir=/r/.git push", "git push"],
    ["git --git-dir /r/.git --work-tree /r push", "git push"],
    ["git --work-tree=/r push", "git push"],
    ["git --namespace foo push", "git push"],
    ["git --namespace=foo push", "git push"],
    ["git -p push", "git push"],
    ["git --paginate push", "git push"],
    ["git -P push", "git push"],
    ["git --no-pager push", "git push"],
    ["git --exec-path=/usr/libexec/git-core push", "git push"],
    ["git --bare --no-optional-locks --literal-pathspecs push", "git push"],
    ["git --config-env user.name=NAME push", "git push"],
  ])("%s → %s", (cmd, want) => {
    expect(lines(cmd)).toEqual([want]);
  });
});

describe("vcsInvocations — gh / glab repo selectors are skipped wherever they sit", () => {
  it.each([
    ["glab -R owner/repo ci run", "glab ci run"],
    ["glab --repo owner/repo ci run", "glab ci run"],
    ["glab --repo=owner/repo mr create --fill", "glab mr create --fill"],
    ["gh -R owner/repo workflow run smoke.yml", "gh workflow run smoke.yml"],
    ["gh -Rowner/repo pr merge 3", "gh pr merge 3"],
    ["gh -R=owner/repo pr create", "gh pr create"],
    ["gh pr -R owner/repo create", "gh pr create"],
    ["glab mr --repo owner/repo merge 7", "glab mr merge 7"],
  ])("%s → %s", (cmd, want) => {
    expect(lines(cmd)).toEqual([want]);
  });
});

describe("vcsInvocations — how the command is reached does not hide it", () => {
  it.each([
    ["/usr/bin/git -C . push", "git push"],
    ["/opt/homebrew/bin/glab -R o/r ci run", "glab ci run"],
    ["\\git -C . push", "git push"],
    ['"git" -C . push', "git push"],
    ["env GIT_TRACE=1 git -C . push", "git push"],
    ["FOO=1 git -C . push", "git push"],
    ["command git -C . push", "git push"],
    ["exec git -C . push", "git push"],
    ["sudo -u bob git -C . push", "git push"],
    ["xargs -I{} git -C {} push", "git push"],
    ["/usr/libexec/git-core/git-push origin main", "git push origin main"],
    ['"$(git --exec-path)"/git-push origin main', "git push origin main"],
    ["git-push origin", "git push origin"],
    ["$HOME/bin/gh -R o/r pr create", "gh pr create"],
  ])("%s", (cmd, want) => {
    expect(lines(cmd)).toContain(want);
  });

  it.each([
    ["cd x && git -C . push", "git push"],
    ["git status; git -C . push", "git push"],
    ["git status || git -C . push", "git push"],
    ["true | git -C . push", "git push"],
    ["git status\ngit -C . push", "git push"],
    ["echo $(git -C . push)", "git push"],
    ['echo "$(git -C . push)"', "git push"],
    ["echo `git -C . push`", "git push"],
    ["bash -c 'git -C . push'", "git push"],
    ['sh -c "cd x && git -C . push"', "git push"],
    ["eval 'git -C . push'", "git push"],
    ["bash <<'EOF'\ngit -C . push\nEOF", "git push"],
    ["(git -C . push)", "git push"],
    ["{ git -C . push; }", "git push"],
  ])("%s", (cmd, want) => {
    expect(lines(cmd)).toContain(want);
  });
});

describe("vcsInvocations — what cannot be read confidently says so", () => {
  it.each([
    ["git -c alias.p=push p", /alias/],
    ["git -c Alias.p=push p", /alias/],
    ["git --config-env alias.p=VAR p", /alias/],
    ["git --frobnicate push", /--frobnicate/],
    ["git -Cdir push", /-Cdir/],
    ["git $VERB origin", /expansion/],
    ["git $(echo push)", /expansion/],
    ['git "$(printf push)" origin', /expansion/],
    ["gh --weird pr create", /--weird/],
    ["glab mr $VERB", /expansion/],
    // Advisor review, 2026-10-31: plain-form aliases the first cut missed.
    ["git -c help.autocorrect=immediate pus", /alias/],
    ["git -c help.autocorrect=1 pus origin", /alias/],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p", /GIT_CONFIG_COUNT/],
    ["GIT_CONFIG_PARAMETERS=\"'alias.p=push'\" git p", /GIT_CONFIG_PARAMETERS/],
    ["env GIT_CONFIG_COUNT=1 git p", /GIT_CONFIG_COUNT/],
    ["GIT_EXEC_PATH=/tmp/x git push", /GIT_EXEC_PATH/],
    ["$(which git) push origin main", /substitution/],
    ["`command -v git` push", /substitution/],
    // An executor this table does not model is read strictly, not leniently.
    ["find . -exec git -c alias.p=push p {} ;", /alias/],
    ["ssh host git --frobnicate push", /--frobnicate/],
    // security-audit probe: the subcommand arrives from input, not the command.
    ["echo push | xargs git -C .", /input/],
    ["find . -exec git {} ;", /input/],
  ])("%s is unclear", (cmd, why) => {
    const inv = vcsInvocations(cmd).find((i) => i.unclear);
    expect(inv?.unclear, cmd).toMatch(why);
  });

  it.each([
    "git -C . status",
    "git -c core.quotepath=off status",
    "git --no-pager log --oneline",
    "git log --format=%H $(git merge-base a b)..HEAD",
    "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
    "gh --version",
    "gh pr view --json title",
    "glab -R o/r mr list",
    "glab mr create --help",
    "git --help push",
    "git",
    "env GIT_TRACE=1 git -C . status",
    "rg git --type ts",
    "grep -n git $FILE",
    "brew upgrade gh --greedy",
    "git diff gh -- x",
    "man git-push",
  ])("%s is clear", (cmd) => {
    for (const inv of vcsInvocations(cmd)) expect(inv.unclear, `${cmd} → ${inv.line}`).toBeUndefined();
  });
});

describe("vcsInvocations — ordinary commands", () => {
  it("finds nothing where there is no git / gh / glab", () => {
    expect(vcsInvocations("ls -la")).toEqual([]);
    expect(vcsInvocations("cat .gitignore")).toEqual([]);
    expect(vcsInvocations("ls .git/hooks")).toEqual([]);
    expect(vcsInvocations("")).toEqual([]);
  });

  it("keeps the subcommand and its arguments", () => {
    expect(lines("git -C . status --short")).toEqual(["git status --short"]);
    expect(lines("git log --oneline -5")).toEqual(["git log --oneline -5"]);
    expect(vcsInvocations("git -C /x -c a=b diff")[0]?.globals).toEqual(["-C", "/x", "-c", "a=b"]);
  });
});
