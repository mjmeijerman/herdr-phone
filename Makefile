# herdr-phone — the one way to run the suite. Zero dependencies: node:test only.
# `make test` locally, `make scripts-test` from bin/preflight (that is the name it detects).
.PHONY: test scripts-test

test:
	node --test tests/*.test.mjs

scripts-test:
	node --test tests/*.test.mjs
