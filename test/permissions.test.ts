import { describe, expect, it } from "vitest";
import {
  accessForProject,
  accessForTeam,
  accessForTenant,
  accessForWorkspace,
  type RoleChain,
} from "../src/permissions";

const chain = (partial: Partial<RoleChain>): RoleChain => ({
  tenant: null,
  workspace: null,
  team: null,
  project: null,
  ...partial,
});

describe("tenant access", () => {
  it("non-member has nothing", () => {
    expect(accessForTenant(chain({}))).toEqual({
      read: false,
      write: false,
      admin: false,
    });
  });
  it("member can read/write but not admin", () => {
    expect(accessForTenant(chain({ tenant: "member" }))).toEqual({
      read: true,
      write: true,
      admin: false,
    });
  });
  it("admin and owner administer", () => {
    expect(accessForTenant(chain({ tenant: "admin" })).admin).toBe(true);
    expect(accessForTenant(chain({ tenant: "owner" })).admin).toBe(true);
  });
});

describe("workspace access", () => {
  it("plain tenant member has no implicit workspace access", () => {
    expect(accessForWorkspace(chain({ tenant: "member" })).read).toBe(false);
  });
  it("tenant admin inherits full workspace access", () => {
    expect(accessForWorkspace(chain({ tenant: "admin" }))).toEqual({
      read: true,
      write: true,
      admin: true,
    });
  });
  it("workspace member reads/writes, admin administers", () => {
    const c = chain({ tenant: "member", workspace: "member" });
    expect(accessForWorkspace(c)).toEqual({
      read: true,
      write: true,
      admin: false,
    });
    const a = chain({ tenant: "member", workspace: "admin" });
    expect(accessForWorkspace(a).admin).toBe(true);
  });
  it("workspace member under a tenant admin is admin by inheritance", () => {
    const c = chain({ tenant: "admin", workspace: "member" });
    expect(accessForWorkspace(c).admin).toBe(true);
  });
});

describe("team access", () => {
  it("workspace member inherits team read/write", () => {
    const c = chain({ tenant: "member", workspace: "member" });
    expect(accessForTeam(c)).toEqual({
      read: true,
      write: true,
      admin: false,
    });
  });
  it("team lead administers the team", () => {
    const c = chain({ tenant: "member", team: "lead" });
    expect(accessForTeam(c).admin).toBe(true);
  });
  it("workspace admin administers teams without a team role", () => {
    const c = chain({ tenant: "member", workspace: "admin" });
    expect(accessForTeam(c).admin).toBe(true);
  });
  it("stranger has no team access", () => {
    expect(accessForTeam(chain({})).read).toBe(false);
  });
});

describe("project access", () => {
  it("viewer is read-only", () => {
    const c = chain({ tenant: "member", project: "viewer" });
    expect(accessForProject(c)).toEqual({
      read: true,
      write: false,
      admin: false,
    });
  });
  it("editor writes, admin administers", () => {
    expect(
      accessForProject(chain({ tenant: "member", project: "editor" })).write,
    ).toBe(true);
    expect(
      accessForProject(chain({ tenant: "member", project: "admin" })).admin,
    ).toBe(true);
  });
  it("explicit viewer stays read-only even as team member", () => {
    const c = chain({ tenant: "member", team: "member", project: "viewer" });
    expect(accessForProject(c).write).toBe(false);
  });
  it("team lead administers projects (overrides explicit viewer)", () => {
    const c = chain({ tenant: "member", team: "lead", project: "viewer" });
    expect(accessForProject(c)).toEqual({
      read: true,
      write: true,
      admin: true,
    });
  });
  it("team member inherits project read/write without explicit role", () => {
    const c = chain({ tenant: "member", team: "member" });
    expect(accessForProject(c)).toEqual({
      read: true,
      write: true,
      admin: false,
    });
  });
  it("workspace admin and tenant owner administer projects", () => {
    expect(
      accessForProject(chain({ tenant: "member", workspace: "admin" })).admin,
    ).toBe(true);
    expect(accessForProject(chain({ tenant: "owner" })).admin).toBe(true);
  });
  it("plain tenant member alone has no project access", () => {
    expect(accessForProject(chain({ tenant: "member" })).read).toBe(false);
  });
});
