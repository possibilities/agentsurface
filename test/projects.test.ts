import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderProjects, projectIndexForCwd, scanProjects } from "../src/projects.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function sandbox(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-projects-"));
  temps.push(temp);
  return temp;
}

describe("scanProjects", () => {
  test("offers the root itself, then its directories, skipping files, dot names, and absent roots", () => {
    const home = sandbox();
    mkdirSync(join(home, "code", "alpha"), { recursive: true });
    mkdirSync(join(home, "code", "beta"));
    mkdirSync(join(home, "code", ".hidden"));
    writeFileSync(join(home, "code", "notes.md"), "");
    const found = scanProjects(["~/code", "~/src"], home);
    expect(found).toEqual([
      join(home, "code"),
      join(home, "code", "alpha"),
      join(home, "code", "beta"),
    ]);
  });
});

describe("projectIndexForCwd", () => {
  test("the longest containing project wins; no match falls back to the head", () => {
    const projects = [
      { path: "/h/code/app", display: "app", count: 0 },
      { path: "/h/code/app-extras", display: "app-extras", count: 0 },
    ];
    expect(projectIndexForCwd(projects, "/h/code/app-extras/src")).toBe(1);
    expect(projectIndexForCwd(projects, "/h/code/app")).toBe(0);
    expect(projectIndexForCwd(projects, "/elsewhere")).toBe(0);
  });
});

describe("orderProjects", () => {
  test("most-launched first, alphabetical on ties, with tilde display", () => {
    const home = "/home/u";
    const paths = [`${home}/code/zeta`, `${home}/code/alpha`, `${home}/src/beta`];
    const counts = new Map([[`${home}/src/beta`, 2]]);
    const ordered = orderProjects(paths, counts, home);
    expect(ordered.map((project) => project.display)).toEqual([
      "~/src/beta",
      "~/code/alpha",
      "~/code/zeta",
    ]);
    expect(ordered[0]?.count).toBe(2);
  });
});
