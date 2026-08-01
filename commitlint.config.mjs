// Conventional Commits — https://www.conventionalcommits.org/
// Validates PR + push commit messages via .github/workflows/commitlint.yml.
//
// Local use (optional):
//   npx --package=@commitlint/cli --package=@commitlint/config-conventional \
//     -- commitlint --from origin/main
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Dependabot bodies open with "Bumps [pkg](url) from x to y.", past the
    // 100-char default. Current commitlint exempts lines that are mostly an
    // unbreakable URL, but the commitlint pinned inside
    // wagoid/commitlint-github-action@v6 does not, so the rule is a CI-only
    // false positive. The workflow already skips dependabot[bot], but that
    // only covers the PR — after the squash-merge the message lands on a main
    // push authored by a human, where it can no longer be fixed without
    // rewriting history. Off, matching sjs-ops / cloud / oss.
    "body-max-line-length": [0],
  },
};
