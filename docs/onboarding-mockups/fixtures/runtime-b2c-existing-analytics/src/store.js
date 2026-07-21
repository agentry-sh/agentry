export function createStore() {
  return {
    users: new Map(),
    sessions: new Map(),
    notes: new Map(),
    shares: [],
    nextUser: 1,
    nextNote: 1,
    nextShare: 1,
  };
}

export function createSignup(store, { email, source, utmSource }) {
  const user = {
    id: `user_${store.nextUser}`,
    email,
    source,
    utm_source: utmSource,
  };
  store.nextUser += 1;
  const sessionToken = `session_${user.id}`;
  store.users.set(user.id, user);
  store.sessions.set(sessionToken, user.id);
  return { user, sessionToken };
}

export function requireUser(store, sessionToken) {
  const userId = store.sessions.get(sessionToken);
  const user = userId ? store.users.get(userId) : null;
  if (!user) {
    const error = new Error("invalid_session");
    error.status = 401;
    throw error;
  }
  return user;
}

export function createNote(store, { userId, title, body }) {
  const note = {
    id: `note_${store.nextNote}`,
    user_id: userId,
    title,
    body,
  };
  store.nextNote += 1;
  store.notes.set(note.id, note);
  return note;
}

export function requireOwnedNote(store, noteId, userId) {
  const note = store.notes.get(noteId);
  if (!note || note.user_id !== userId) {
    const error = new Error("note_not_found");
    error.status = 404;
    throw error;
  }
  return note;
}

export function recordShare(store, { noteId, channel, destination }) {
  const share = {
    id: `share_${store.nextShare}`,
    note_id: noteId,
    channel,
    destination,
  };
  store.nextShare += 1;
  store.shares.push(share);
  return share;
}
