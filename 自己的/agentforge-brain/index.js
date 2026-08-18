/**
 * AgentForge Brain — host half.
 *
 * Deliberately empty: everything this plugin contributes is the browser-side
 * `conversation.view` tab, delivered through the `dsh.client` manifest and
 * `client.js`. The row must still export a loadable host plugin so the Loader
 * can mount it.
 */

export const name = 'agentforge-brain'

/** No host-side behavior. */
export function apply() {}
