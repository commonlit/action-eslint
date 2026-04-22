# GitHub Action: Run oxlint with reviewdog

This action runs [oxlint](https://oxc.rs/docs/guide/usage/linter.html) with
[reviewdog](https://github.com/reviewdog/reviewdog) on pull requests to improve
code review experience.

## Migrating from older versions of this action (eslint)

Earlier versions of this action ran eslint. Starting with the oxlint rewrite,
the following breaking changes apply:

- `eslint_flags` input → `oxlint_flags`.
- `node_options` input removed (oxlint is a native binary; `NODE_OPTIONS` has no effect).
- `tool_name` default changed from `eslint` to `oxlint`.
- You must list `oxlint` (not `eslint`) in your project's `devDependencies` (or equivalent).

## Inputs

### `github_token`
**Required.** Default `${{ github.token }}`.

### `level`
Optional. Report level for reviewdog (`info`, `warning`, `error`). Same as reviewdog's `-level` flag.

### `reporter`
Optional. `github-pr-check`, `github-check`, or `github-pr-review`. Default `github-pr-review`.

### `tool_name`
Optional. Default `oxlint`. Becomes the check/run name on GitHub and the tool label in review comments.

### `filter_mode`
Optional. `added`, `diff_context`, `file`, or `nofilter`. Default `added`.

### `fail_level`
Optional. `none`, `any`, `info`, `warning`, or `error`. Default `none`.

### `fail_on_error`
Deprecated. Use `fail_level`.

### `reviewdog_flags`
Optional. Additional flags passed to reviewdog.

### `oxlint_flags`
Optional. Flags and args for the `oxlint` command. Default `.`.

### `workdir`
Optional. Directory from which to run oxlint. Default `.`.

## Example usage

Install oxlint in your project:

```shell
npm install --save-dev oxlint
```

See the [oxlint configuration docs](https://oxc.rs/docs/guide/usage/linter/config.html)
for creating a `.oxlintrc.json`. This action uses that config automatically.

### `.github/workflows/reviewdog.yml`

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    name: runner / oxlint
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: commonlit/action-eslint@vX
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          reporter: github-pr-review
          oxlint_flags: "src/"
```

You can also set up Node and oxlint manually:

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - uses: commonlit/action-eslint@vX
        with:
          reporter: github-check
          oxlint_flags: "src/"
```

### Matrix example with unique tool name

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - uses: commonlit/action-eslint@vX
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          reporter: github-check
          tool_name: oxlint-node-${{ matrix.node }}
          oxlint_flags: "src/"
```
