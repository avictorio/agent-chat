// Durable Object stand-ins for node --test: a namespace whose stubs call the
// class's fetch(), and ctx.storage.sql backed by node:sqlite (so the real
// SQL runs). Instances live as long as the namespace, like a warm DO.

import { DatabaseSync } from 'node:sqlite';

class FakeSql {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  exec(query, ...bindings) {
    const rows = this.db.prepare(query).all(...bindings).map((r) => ({ ...r }));
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error('expected exactly one row');
        return rows[0];
      },
    };
  }
}

export class FakeNamespace {
  constructor(Class, env) {
    this.Class = Class;
    this.env = env;
    this.instances = new Map();
  }
  idFromName(name) {
    return { name, toString: () => name };
  }
  instance(name) {
    let inst = this.instances.get(name);
    if (!inst) {
      inst = new this.Class({ id: this.idFromName(name), storage: { sql: new FakeSql() } }, this.env);
      this.instances.set(name, inst);
    }
    return inst;
  }
  get(id) {
    return {
      fetch: (input, init) => this.instance(id.name).fetch(new Request(input, init)),
    };
  }
}
