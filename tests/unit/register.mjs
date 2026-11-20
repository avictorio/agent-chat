// `node --import ./tests/unit/register.mjs --test ...`: install the text-module hooks.
import { register } from "node:module";
register("./txt-hooks.mjs", import.meta.url);
