export function createTldrAgentEnvelopeHelpers(errorCatalog) {
  function success(data) {
    return { ok: true, data, error: null };
  }
  function failure(code, { remediation } = {}) {
    const [message, retryable] =
      errorCatalog[code] ?? errorCatalog.ARGUMENT_INVALID;
    return {
      ok: false,
      data: null,
      error: {
        code: errorCatalog[code] ? code : "ARGUMENT_INVALID",
        message,
        retryable,
        ...(remediation ? { remediation } : {}),
      },
    };
  }
  return { success, failure };
}
