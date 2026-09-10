import { describe, expect, it, vi } from "vitest";
import { PageSessionController, type PageSessionSnapshot } from "./page-session";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("page account controller", () => {
  it("serializes repeated sign-in and sign-out requests within the current runtime", async () => {
    const controller = new PageSessionController();
    const gate = deferred();
    const login = vi.fn(async (_email: string, _password: string) => gate.promise);
    const logout = vi.fn(async () => undefined);
    controller.attach({ login, logout });
    const first = controller.login("first@example.test", "first-secret");
    const repeated = controller.login("other@example.test", "other-secret");
    const overlappingLogout = controller.logout();
    expect(controller.getSnapshot().busy).toBe(true);
    await Promise.resolve();
    expect(login).toHaveBeenCalledExactlyOnceWith("first@example.test", "first-secret");
    expect(logout).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, repeated, overlappingLogout]);
    expect(controller.getSnapshot().busy).toBe(false);
    await controller.logout();
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a runtime detached before its login microtask starts", async () => {
    const controller = new PageSessionController();
    const login = vi.fn(async () => undefined);
    const detach = controller.attach({ login, logout: async () => undefined });
    const pending = controller.login("old@example.test", "old-secret");
    detach();
    await pending;
    expect(login).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ ready: false, busy: false, customer: null, profile: null, history: [] });
  });

  it("starts the new runtime's login instead of returning the detached request", async () => {
    const controller = new PageSessionController();
    const oldLogin = vi.fn(async () => undefined);
    const detach = controller.attach({ login: oldLogin, logout: async () => undefined });
    const oldRequest = controller.login("old@example.test", "old-secret");
    detach();
    const gate = deferred();
    const newLogin = vi.fn(async (_email: string, _password: string) => gate.promise);
    controller.attach({ login: newLogin, logout: async () => undefined });
    const newRequest = controller.login("new@example.test", "new-secret");
    await oldRequest;
    expect(oldLogin).not.toHaveBeenCalled();
    expect(newLogin).toHaveBeenCalledExactlyOnceWith("new@example.test", "new-secret");
    expect(controller.getSnapshot()).toMatchObject({ ready: true, busy: true });
    gate.resolve();
    await newRequest;
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it.each(["success", "failure"] as const)("ignores an old %s while a new runtime is still busy", async (outcome) => {
    const controller = new PageSessionController();
    const oldGate = deferred();
    const oldLogin = vi.fn(async () => oldGate.promise);
    const detach = controller.attach({ login: oldLogin, logout: async () => undefined });
    const oldRequest = controller.login("old@example.test", "old-secret");
    await Promise.resolve();
    expect(oldLogin).toHaveBeenCalledTimes(1);
    detach();
    const newGate = deferred();
    const newLogin = vi.fn(async () => newGate.promise);
    controller.attach({ login: newLogin, logout: async () => undefined });
    const newRequest = controller.login("new@example.test", "new-secret");
    await Promise.resolve();
    expect(newLogin).toHaveBeenCalledTimes(1);
    controller.update({ error: "Current account message", open: true });
    if (outcome === "success") oldGate.resolve();
    else oldGate.reject(new Error("Old account failed with a private diagnostic"));
    await oldRequest;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, busy: true, open: true, error: "Current account message" });
    newGate.resolve();
    await newRequest;
    expect(controller.getSnapshot()).toMatchObject({ busy: false, error: "Current account message" });
  });

  it("does not let stale detach cleanup erase a newer runtime's account state", async () => {
    const controller = new PageSessionController();
    const oldDetach = controller.attach({ login: async () => undefined, logout: async () => undefined });
    const login = vi.fn(async () => undefined);
    controller.attach({ login, logout: async () => undefined });
    controller.update({ open: true, error: "Current account message" });
    oldDetach();
    expect(controller.getSnapshot()).toMatchObject({ ready: true, open: true, error: "Current account message" });
    await controller.login("new@example.test", "new-secret");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("sends credentials only to the direct runtime callback, never into snapshots or error text", async () => {
    const controller = new PageSessionController();
    const snapshots: PageSessionSnapshot[] = [];
    const unsubscribe = controller.subscribe(() => snapshots.push(controller.getSnapshot()));
    const email = "private-address@example.test";
    const password = "PRIVATE-PASSWORD-CANARY";
    const gate = deferred();
    const login = vi.fn(async (_email: string, _password: string) => gate.promise);
    controller.attach({ login, logout: async () => undefined });
    controller.requestLogin();
    const request = controller.login(email, password);
    await Promise.resolve();
    expect(login).toHaveBeenCalledExactlyOnceWith(email, password);
    expect(controller.getSnapshot().busy).toBe(true);
    gate.reject(new Error(`Failure for ${email} using ${password}`));
    await request;
    expect(controller.getSnapshot().error).toBeTruthy();
    const serialized = JSON.stringify(snapshots);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"token"');
    unsubscribe();
  });

  it("rejects an unavailable runtime with a localized message and no busy operation", async () => {
    const controller = new PageSessionController();
    controller.update({ language: "ar" });
    await controller.login("person@example.test", "example-secret");
    expect(controller.getSnapshot()).toMatchObject({ ready: false, busy: false });
    expect(controller.getSnapshot().error).toContain("الحساب");
    expect(controller.getSnapshot().error).not.toContain("example-secret");
  });
});
