import { appleMailProvider } from "./apple-mail";
import type { MailProvider, MailProviderRegistry } from "./provider";

const registry = new Map<string, MailProvider>([[appleMailProvider.id, appleMailProvider]]);

let activeProviderId: string = appleMailProvider.id;

export const mailProviders: MailProviderRegistry = {
  list() {
    return [...registry.values()].map((p) => ({ id: p.id, name: p.name }));
  },

  get(id: string) {
    return registry.get(id);
  },

  getActive() {
    return registry.get(activeProviderId) ?? appleMailProvider;
  },

  setActive(id: string) {
    if (!registry.has(id)) throw new Error(`Unknown provider: ${id}`);
    activeProviderId = id;
  },
};
