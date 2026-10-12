# ZuecanRWAton

Tokenized government money-market fund on Canton, written in Daml 3.4. Read `README.md` and `docs/ARCHITECTURE.md` before changing the model.

## Conventions

- Answer the user in Chinese. Docs under `docs/` and `README.md` are in Chinese; Daml code and comments are in English.
- `main/` is the ledger package. It must not depend on `daml-script`: it is the DAR that goes on a participant and gets upgraded with Smart Contract Upgrade.
- `test/` holds every Daml Script scenario. Add each new scenario to `Test.Canton.scenarios` too; `scripts/daml-test.sh` fails if one is missing.
- `Zuecan.Registry` is the book of record: the register and every unit contract live in one module because issuance creates holdings and redemption payouts update the register. Every unit contract (holding or escrow) is signed by registrar, custodian and owner; keep it that way, it is what stops units appearing outside the register.
- No contract keys (Canton 3.x does not enforce their uniqueness). Every choice takes the contract ids it relies on (terms, NAV, register, credential) and checks they belong to the same instrument and role.
- Any path that delivers fund units to a party must call `checkEligible` on the receiver's credential. Any path that pays a party must call `checkScreened`.
- Escrowed assets always keep an exit:
  - cash locks lapse back to the owner;
  - matched trades can be aborted after their deadline.

## Tests

```bash
scripts/daml-test.sh      # IDE ledger + coverage gate; needs Docker
scripts/canton-test.sh    # same scenarios on a Canton sandbox participant (~10 min)
scripts/mutation_test.py  # mutation test (~20 min)
```

- Every new choice needs a scenario that exercises it. CI fails if any non-Archive choice is never exercised.
- Failure cases use `expectFailure "<part of the assertMsg text>"` rather than a bare `submitMustFail`, so a test cannot pass because of an unrelated error. Use `submitMustFail` only when the failure is an archived or invisible contract.
- End scenarios that move units with `checkReconciles w`. It asserts that the units the regulator sees, including units in escrow, equal the register's `outstanding`.
- Mutation-test a new safety check: add it to `MUTANTS` in `scripts/mutation_test.py` and confirm it is killed.
- Parties come from `freshParty`, never a fixed hint: on a real participant all scenarios share one ledger.

## Environment

- The Daml SDK comes from the Docker image `digitalasset/daml-sdk:3.4.0-rc2`; CI pins it by digest. The 3.4 stable release is only published through `dpm`.
- The image runs as user `daml`, so the repo must be world-writable before `docker run` (`scripts/daml-test.sh` does this).
