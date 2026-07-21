export async function sendSms({ noteId, phone }) {
  await Promise.resolve();
  if (!phone || phone.endsWith("0000")) {
    const error = new Error("sms_provider_timeout");
    error.code = "sms_provider_timeout";
    throw error;
  }
  return {
    message_id: `sms_${noteId}`,
    provider: "notespark-sms",
  };
}
