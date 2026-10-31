// node --import ./tests/script_mock/register.mjs : maps the engine modules to the fakes.
import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url));
