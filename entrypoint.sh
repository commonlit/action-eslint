#!/bin/sh

export REVIEWDOG_GITHUB_API_TOKEN="${INPUT_GITHUB_TOKEN}"
ESLINT_FORMATTER='/formatter.js'

cd "${GITHUB_WORKSPACE}/${INPUT_WORKDIR}" || exit 1

# Rewrite package.json so that it only contains the packages we're about to use.
# The lockfile will remain the same so the package versions should match what
# we have checked in as the versions for local development.
echo $(cat package.json | jq 'to_entries | map(if .key == "dependencies" or .key == "devDependencies" then . + {"value": .value | to_entries | map(select(.key | test("(eslint|\\A(jest|typescript)\\Z)"))) | from_entries} else . end) | from_entries') > package.json
yarn install

$(yarn bin)/eslint --version

$(yarn bin)/eslint -f="${ESLINT_FORMATTER}" ${INPUT_ESLINT_FLAGS:-'.'} \
  | reviewdog -f=rdjson \
      -name="${INPUT_TOOL_NAME}" \
      -reporter="${INPUT_REPORTER:-github-pr-review}" \
      -filter-mode="${INPUT_FILTER_MODE}" \
      -fail-on-error="${INPUT_FAIL_ON_ERROR}" \
      -level="${INPUT_LEVEL}" \
      ${INPUT_REVIEWDOG_FLAGS}
