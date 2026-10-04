// Stands in for the Workers runtime module, so tests can import server functions (their
// validators, their middleware) without a worker. Nothing here is ever read by the tests.
export const env = {}
