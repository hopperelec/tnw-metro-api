// Type-checking utility for ensuring that the stubs match the private library, if it is installed.
// This is never imported; it only exists for `tsc`.

// @ts-ignore: If the library isn't installed, this is `any`, so the checks below pass
import type * as Library from "tnw-metro-api-private";
import type * as Stub from "./stub";

// Checked in both directions, so that any error points to the specific export which doesn't match
const libraryMatchesStub: typeof Stub = null as typeof Library;
const stubMatchesLibrary: typeof Library = null as typeof Stub;
