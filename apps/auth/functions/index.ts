import { noStoreRedirect } from "./_responses.ts";

const REPOSITORY = "https://github.com/agentry-sh/agentry";

export const onRequestGet: PagesFunction = async () => noStoreRedirect(REPOSITORY);

export const onRequestHead = onRequestGet;
