export const invalidCharts = [
  { kind: "pie", x: ["A"], series: [{ name: "one", values: [1] }, { name: "two", values: [2] }] },
  { kind: "pie", x: ["A", "B"], series: [{ name: "one", values: [2, -1] }] },
  { kind: "pie", x: ["A"], series: [{ name: "zero", values: [0] }] },
  { kind: "bar", stacked: true, x: ["A"], series: [{ name: "one", values: [-1] }] },
  { kind: "bar", stacked: true, horizontal: true, x: ["A"], series: [{ name: "one", values: [1] }, { name: "two", values: [-2] }] },
  { kind: "line", x: ["A", "B"], series: [{ name: "short", values: [1] }] },
  { kind: "bar", x: ["A"], series: [{ name: "long", values: [1, 2] }] },
];

export const validCharts = [
  { kind: "pie", x: ["A", "B"], series: [{ name: "one", values: [0, 2] }] },
  { kind: "bar", stacked: true, x: ["A"], series: [{ name: "one", values: [0] }] },
  { kind: "bar", horizontal: true, x: ["A"], series: [{ name: "one", values: [-2] }] },
  { kind: "line", stacked: true, x: ["A", "B"], series: [{ name: "one", values: [-1, 0] }] },
];
