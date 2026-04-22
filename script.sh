#!/bin/sh

cd "${GITHUB_WORKSPACE}/${INPUT_WORKDIR}" || exit 1

TEMP_PATH="$(mktemp -d)"
PATH="${TEMP_PATH}:$PATH"
export REVIEWDOG_GITHUB_API_TOKEN="${INPUT_GITHUB_TOKEN}"

echo '::group::🐶 Installing reviewdog ... https://github.com/reviewdog/reviewdog'
curl -sfL https://raw.githubusercontent.com/reviewdog/reviewdog/fd59714416d6d9a1c0692d872e38e7f8448df4fc/install.sh | sh -s -- -b "${TEMP_PATH}" "${REVIEWDOG_VERSION}" 2>&1
echo '::endgroup::'

npx --no-install -c 'oxlint --version' 2>/dev/null
if [ $? -ne 0 ]; then
  echo '::group:: Running `npm install` to install oxlint ...'
  set -e
  npm install
  set +e
  echo '::endgroup::'
fi

echo "oxlint version:$(npx --no-install -c 'oxlint --version')"

echo '::group:: Running oxlint with reviewdog 🐶 ...'
npx --no-install -c "oxlint --format=json ${INPUT_OXLINT_FLAGS:-'.'}" \
  | node "${GITHUB_ACTION_PATH}/oxlint-to-rdjsonl.js" \
  | reviewdog -f=rdjsonl \
      -name="${INPUT_TOOL_NAME}" \
      -reporter="${INPUT_REPORTER:-github-pr-review}" \
      -filter-mode="${INPUT_FILTER_MODE}" \
      -fail-level="${INPUT_FAIL_LEVEL}" \
      -fail-on-error="${INPUT_FAIL_ON_ERROR}" \
      -level="${INPUT_LEVEL}" \
      ${INPUT_REVIEWDOG_FLAGS}

reviewdog_rc=$?
echo '::endgroup::'
exit $reviewdog_rc
