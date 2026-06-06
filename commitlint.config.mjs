// Conventional Commits — https://www.conventionalcommits.org/
// Validates PR + push commit messages via .github/workflows/commitlint.yml.
//
// Local use (optional):
//   npx --package=@commitlint/cli --package=@commitlint/config-conventional \
//     -- commitlint --from origin/main
export default {
  extends: ["@commitlint/config-conventional"],
};
