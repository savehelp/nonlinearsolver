# Node — nonlinear equation workbench

A browser-based nonlinear algebraic equation solver built with TypeScript, React, Vite, and Plotly. Equations are the source of truth, with optional reusable element templates loaded from JSON. There are no required transistor parameters, schematic, server, or Python runtime. All numerical work runs in a cancellable Web Worker. The app opens an RC low-pass filter example in complex mode when no saved workspace is present. **New equation workspace** starts with `y = a*x + b;`, `set_time_axis x`, and `plot y`.

## How to use

### 1. Open the standalone HTML (recommended)

1. Download [dist/index.html](./dist/index.html) as a raw HTML file, or find it in your copy of this repository. On GitHub, use the file page's download button.
2. Open the downloaded file in **Chrome or Edge**. If your editor shows the HTML source, open the file in your browser instead.
3. Start editing equations or choose an example from the settings gear.

The checked-in file is ready to use: no installation, build, Node.js, or local server is required. It includes the app, styles, solver worker, and bundled element library, and works offline. You can copy or share this single HTML file. To share your own equations and custom element definitions, also export your workspace as JSON from Settings.

### 2. Run with Vite

Use this method when developing or editing the app's source. Install [Node.js](https://nodejs.org/) **22 or later**, download or clone this repository, and open a terminal in the project folder:

```sh
npm ci
npm run dev
```

Open the local URL printed in the terminal. Vite updates the page as you edit the source. Press **Ctrl+C** in the terminal to stop it.

To create an updated standalone file after source changes, run:

```sh
npm run build
```

This type-checks the app and writes `dist/index.html` without starting a server. Open that file directly as described in method 1. Run `npm test` for the numerical and parser tests. To serve an existing production build locally, use `npm run preview`.

In Windows PowerShell, use `npm.cmd` if an execution policy blocks `npm.ps1`. VS Code also provides **Terminal → Run Task → Run workbench**, **Build workbench**, and **Test workbench**; **Ctrl+Shift+B** builds. Restart VS Code after installing Node.js so its terminals receive the updated PATH. Keep `package-lock.json` with the project so `npm ci` installs the same dependency versions.

### Write equations and plot results

1. **Choose a starting point.** Your saved workspace restores on startup. Otherwise, the app opens the RC low-pass example in complex mode, plotting gain and phase against frequency. Use the settings gear to load another example, including **NMOS element · resistor load**, or select **New equation workspace** to start your own model.
2. **Edit the model.** Equations go on the left, plots on the right, and parameter controls below. End equations and validity checks with `;`; use `#` for comments. Equations can span several lines. Use **+** to add source tabs, the pencil or a double-click to rename them, and the trash button to remove them. All tabs share the same model and namespace.
3. **Declare inputs and select a sweep.** Write `parameter name value` for a fixed input. A sweep declaration uses `parameter name start step min max sweep`. Select its traversal parameter with `set_time_axis name`. Other parameters marked `sweep` add slice dimensions; their sliders select already-computed combinations.
4. **Choose plot coordinates.** Write `plot y` to use the traversal parameter on X, or `plot y x` to choose both coordinates. Y always comes first. Add a command for each curve, and use parentheses around expressions containing spaces in the two-coordinate form. All curves follow the same traversal order and share one X scale and one Y scale.
5. **Run and inspect.** Auto-run recomputes after valid model edits. Turn it off to run manually with **Run**. Source errors identify their tab and line; click the status above the graph for diagnostics. Click a plotted point to inspect values, residuals, and its Jacobian. Open the **Constants** tab beside Diagnostics to inspect fixed parameters, folded assignments, and reference-line positions before solving.
6. **Adjust the view.** Scroll to zoom, drag to pan, and use the graph toolbar to reset or export SVG. In **Settings → Graph settings**, turn **Autoscale** off to enter the four axis bounds. Bounds must be finite, with each minimum below its maximum. Panning or zooming also switches to manual bounds; enable Autoscale to fit the data again. Graph view changes do not recompute the sweep. Drag panel dividers to resize them; double-click a divider to collapse a panel and use its visible rail to reopen it.
7. **Save or share your work.** **Save workspace** stores one workspace in this browser. **Export JSON** creates a portable copy containing source tabs, settings, and element definitions; **Import JSON** restores it. To add reusable equation models, use **Settings → Elements → Load element JSON**. **Solver settings** controls complex mode and convergence options; **Sweep settings** summarizes the selected dimensions.

Undeclared names used in equations are inferred as unknowns with a zero initial guess. Add `unknown name guess` when you want to supply a guess. Ordinary plot commands do not introduce new unknowns; qualified element members such as `M1.id` activate their declared model. Parameters stay fixed during each solve, while their sweep selections determine which values are sampled.

Parameter options are **value / sweep start, step, minimum, maximum**, in that order. Omitted guesses and values default to zero. Complete step and bounds produce a slider; fewer options produce a numeric control. Numeric options accept expressions such as `9e-9`, `9*10^(-9)`, and `(2 * pi)`; wrap options containing spaces in parentheses. Declarations and plot commands end at a newline or semicolon. Math statements can share a line, and a tab without semicolons also accepts newline-separated equations. Equalities are solved as left-minus-right zero residuals; a standalone math expression is also treated as a zero residual.

Put computed quantities and validity checks in any tab: `twice = 2*y;` defines a quantity, while `y >= 0;` filters roots. Use `valid expression;` for an explicit Boolean validity check. Up to 16 curves can be plotted. Workspaces support up to 32 tabs, 200,000 source characters, 100 declarations, and 50,000 characters of compiled math. The sweep limits and combined workload appear under **Diagnostics → Sweep plan**. Panel layout and graph view preferences are remembered locally.

For example, the following declarations and equations can share one tab or be split across several:

```text
# Optional declaration supplies an initial guess; y is otherwise inferred
unknown y 1

# Parameters: name, value/start, step, min, max, optional sweep
parameter x 0 0.1 -5 5 sweep
parameter gain 2
parameter offset
```

The same tab, or another tab, can contain relationships and validity checks:

```text
y^2 = gain*x + offset;
twice = 2*y;
y >= 0;
set_time_axis x
plot y
plot twice
```

Here `offset` defaults to zero, `gain` and `offset` have numeric controls, and `twice` is reconstructed from each solution without becoming an independent Newton variable. These one-expression plot commands both use the swept `x` horizontally. The unknown count must match the remaining equation count after safe assignment elimination. If there are too few equations, declare an intended fixed input as a parameter or add an equation; the solver reports underdetermined or overdetermined counts. Inequalities filter solutions and do not replace equality equations. Matching counts is necessary but does not guarantee a solution or uniqueness. Removing every `plot` command clears the curves; transition lines remain until their own commands are removed. Keep `set_time_axis x` and add a `plot` command to display a curve again.

For a parametric curve, supply Y first and X second. This model draws a circle and a separate sine curve on the same graph:

```text
parameter t 0 (pi/32) 0 (2*pi) sweep
x = cos(t);
y = sin(t);
set_time_axis t
plot y x
plot y
```

`plot y x` draws `(cos(t), sin(t))`; `plot y` draws `(t, sin(t))`. Both follow increasing `t`, preserving the circle's loop even when its displayed X coordinate reverses direction. The name "time axis" describes this ordering; the solver still performs algebraic sweeps rather than transient simulation.

### Element libraries

Open the **Elements** tab in Settings to inspect the available element types, load an element JSON library, or download definitions to edit and share. The supplied [NMOSFET library](./elements/nmosfet.json) contains the device equations and default parameters as data. Imported types with the same name replace that type for the current workspace. Saving or exporting a workspace includes its loaded definitions, so recipients can use custom elements without importing a second file.

Declare an instance with `element Type instance`. Its type must be available in the element library. A declaration alone adds no equations or unknowns. Referencing one of its members in math or a plot activates its complete model once. Instances and connections can appear in any source tab, in any order. Removing the final member use removes that instance's generated model.

For example, this complete model sweeps the gate voltage of a resistor-loaded NMOS. Start a new equation workspace, put this model in one source tab and clear the remaining tabs, and keep **Complex mode** disabled:

```text
element NMOSFET M1
parameter vin 0 .1 0 3.3 sweep
parameter Vdd 3.3
parameter R1 2200
parameter M1.VTH .7

M1.g = vin;
M1.s = 0;
M1.d = Vdd - M1.id*R1;
M1.d <= Vdd;

set_time_axis vin
plot M1.d
plot M1.id*1e3
```

`M1.g`, `M1.d`, and `M1.s` are the required gate, drain, and source terminals. `M1.id` is drain-to-source current; `M1.vgs` and `M1.vds` are model-defined members. The example's two curves share a Y scale, with current displayed in milliamps. The supplied model describes a forward-biased, three-terminal DC NMOS with nonnegative drain-source voltage; it is a simple square-law model, with no body effect or AC capacitances. Circuit connection and current-balance equations remain explicit. For example, a separate name `ID` refers to this current only after adding `ID = M1.id;`.

Each instance gets its own parameters and internal variables. Override a parameter with `parameter M1.VTH .65`, supply a solver guess with `unknown M1.id .001`, or give an element parameter the ordinary step/range/`sweep` options. Parameter and guess declarations alone do not activate an unused instance. All required terminals of an active instance must appear in external equations. Unknown instances, misspelled members, parameter/unknown kind mismatches, and incompatible real/complex modes produce errors. `=` retains its ordinary simultaneous-equation meaning; source order never changes a terminal's value.

To add another element type, load a JSON file with this shape:

```json
{
  "format": "nonlinear-elements",
  "version": 1,
  "elements": [
    {
      "name": "Gain",
      "description": "A gain block with one input and a computed output.",
      "mode": "both",
      "terminals": ["input"],
      "parameters": { "gain": { "value": 2 } },
      "equations": ["output = gain*input"]
    }
  ]
}
```

After loading it, use `element Gain A1`, connect `A1.input = signal;`, and plot `A1.output` against your selected traversal parameter. Use `parameter A1.gain 3` to replace the default gain. This also works with complex unknowns when Complex mode is enabled; parameters and plotted coordinates still follow the normal real-value rules.

An element definition has a unique `name`, required `terminals`, numeric `parameters`, and mathematical `equations`. `description`, `mode`, and an `unknowns` map of initial guesses are optional. Each parameter has a finite numeric `value`, with optional `step`, `min`, and `max` slider settings. `mode` is `real`, `complex`, or `both`, defaulting to `both`. Equations may include the ordinary validity conditions. Members are terminal names, parameter names, explicit unknowns, and simple assignment targets such as `output`; dependencies must use these local names or built-in mathematical constants. Their instance prefix is supplied automatically. Element equations use the same safe math parser as source equations and cannot contain declarations, plot commands, or JavaScript. Names are simple identifiers inside the JSON; dotted instance names are used in workspace source. Files must be smaller than 1 MB and are validated before any definitions are applied.

The library is embedded in the standalone HTML, so the supplied element works offline. Loading custom element JSON also works directly from `dist/index.html`, with no server or network fetch.

### Transition lines

Use `plot_x_transition C` to draw a vertical line at **X = C**, or `plot_y_transition C` to draw a horizontal line at **Y = C**. The axis in the command names the coordinate held constant. For example:

```text
parameter R 1k
parameter C 100n
cutoff_rad_s = 1/(R*C);
cutoff_Hz = cutoff_rad_s/(2*pi);
plot_x_transition cutoff_Hz
plot_y_transition (-3)
```

Transition expressions are constant-folded; they do not need to be numeric literals. You can also write the cutoff directly as `plot_x_transition (1/(2*pi*R*C))`. Each expression must evaluate to a finite real constant. It may use fixed parameters, chains of derived assignments, and math functions, including real projections of complex constants in complex mode. Swept parameters and unknown-dependent expressions are not allowed. Up to 32 transition lines can appear alongside curves, or by themselves without a time axis or sweep. The lines extend across the graph viewport and remain full height or width when you zoom or pan. They are graph annotations and add no equation or solver constraint. The usual curve syntax stays Y first: `plot y x`.

### Expressions and units

Safe recursive-descent parsing; no eval, Function, property access, assignments, or arbitrary JavaScript. Supports `+ - * / ^ **`, parentheses, comparisons, `&& || !`, lazy `if(condition, a, b)`, nested conditionals, and ternary syntax. Use explicit multiplication. Functions: `abs sqrt exp log ln log10 sin cos tan asin acos atan atan2 sinh cosh tanh min max pow floor ceil sign`. Constants: `pi e true false`. Scientific notation and attached engineering suffixes work: `1e-3`, `2.2k`, `500u`; supported suffixes are p/n/u/m/k/K/M/G/T, case-sensitive. Unit labels like `V` and `Ohm` are not parsed. Internal values are SI.

Line breaks are whitespace inside semicolon-terminated equations. Nested `if` calls use their existing parentheses and commas; braces are unnecessary:

```text
(VDD - VD) / RD = ID;
ID = if(
  VG <= VTH,
  0,
  K / 2 * (VG - VTH)^2
    * (1 + LAMBDA * VD)
);
```

The supplied NMOS example uses current positive into the drain, ground-referenced voltages, and positive threshold magnitude. The PMOS example uses positive source-to-drain current and positive threshold magnitude; output KCL equates NMOS and PMOS currents. Circuit examples provide initial guesses without preset unknown bounds, so changing the equations does not inherit hidden current/voltage restrictions. Add any intended bounds as validity conditions in Equations. A sweep with no plotted points raises an error; bound-limited failures identify the variable and limit. Arbitrary equations determine your sign conventions. Capacitors contribute no current in ideal DC; AC, transient, noise, schematic capture, and SPICE netlists are outside this version's scope.

### Complex mode

Enable **Settings → Solver settings → Complex mode** to solve complex-valued unknowns. Parameters, parameter sliders, sweep coordinates, and both plot coordinates remain real. With complex mode off, the existing real solver remains in use. The mode is saved and exported with the workspace.

In complex mode, `i` and `j` denote the imaginary unit unless the model declares those names. Use explicit multiplication, for example `2*i`. Arithmetic and supported mathematical functions accept complex values; `sqrt`, `log`/`ln`, and complex powers use principal branches. Functions `real(z)`/`re(z)`, `imag(z)`/`im(z)`, `abs(z)`/`mag(z)`, and `arg(z)`/`phase(z)` return real values; phase is in radians. Use `conj(z)` for conjugation and `complex(a, b)` to construct `a + i*b` from real components. Comparisons, interval bounds, and functions such as `min` or `floor` require real values; write conditions on `real(z)`, `imag(z)`, or `abs(z)` as appropriate.

Plot expressions must evaluate to real values. A complex result reports a plotting error instead of discarding its imaginary part. This example plots a complex-plane circle and its magnitude:

```text
unknown z 1
parameter t 0 (pi/32) 0 (2*pi) sweep
z = exp(i*t);
set_time_axis t
plot imag(z) real(z)
plot abs(z)
```

The first command puts `imag(z)` on Y and `real(z)` on X. The second plots magnitude against `t`. Explicit unknown declarations set real initial guesses; inferred unknowns start at zero. Complex multistart searches include imaginary starting components. The point inspector shows logical complex values as `a + bi`, while residuals and Jacobians use real and imaginary components.

Each complex numerical unknown contributes two real components. This increases numerical work and working-matrix memory; runtime depends on the equations, convergence, multistart guesses, and roots found. Direct assignment and linear paths can avoid Newton work where supported. The number of real plot coordinates does not increase.

### Parameter sweeps

A parameter sweep samples the marked parameters while solving the same unknowns. `set_time_axis` chooses the shared traversal parameter and default horizontal coordinate. Each `plot` command supplies a Y expression followed by an optional X expression, with points connected in traversal order. Set each range, step, and starting value in its parameter declaration; **Sweep settings** summarizes the selected dimensions.

A sweep grid adds parameters distinct from the main traversal parameter and each other. For example, with `y = a*x + b;`, add trailing `sweep` to complete declarations for `x`, `a`, and `b`. If `a` and `b` each have three samples, the app computes nine curves, and their sliders choose which `(a, b)` combination is displayed while X remains `x`. More swept parameters add further slider dimensions. Their counts multiply: three extra parameters with three samples each require 27 full main sweeps. Editing equations, variables, constraints, axes, or sweep/solver settings invalidates the dataset and recomputes it when Auto-run is checked; otherwise select Run. Moving slice sliders preserves the computed set and configured starting values. You can browse completed combinations while later ones are being computed; an unfinished combination is visibly empty until its preview or result arrives. Stop cancels the remaining work and keeps completed combinations available. Only the current dataset is retained. Save/export stores all dimension settings; computed slices are session-only and are recomputed after reload when Auto-run is checked. Older single-extra workspaces remain compatible.

Parameter sweeps begin at their configured starting values and expand outward, lower before higher at equal distances. With one extra parameter, `VDD` start 5, min 0, max 10, and step 1 computes `5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10`. With several extras, the starting combination comes first, followed by combinations with the fewest total sample steps from it. Combinations are generated lazily rather than allocating the full product beforehand. Main-sweep points use the same centered order but plot in increasing parameter order. Each direction has its own adjacent-point continuation seeds, so alternating work does not create zigzag lines or bridge failed samples. Changing the starting value can change finite multistart root discovery; exhaustive discovery is still not guaranteed. An off-grid start anchors its own grid: start 5.2 with step 1 samples 5.2, 4.2, 6.2, etc., staying inside the range. Bounds are included when a step lands on them. The starting value must be inside the range, and step must be positive and produce distinct finite values. A step wider than the range gives one sample.

Main sweeps support up to 50,000 derived points, each additional parameter supports up to 10,000 samples, and the full grid supports at most 250,000 positions: main points multiplied by every additional parameter's count. These larger limits target desktop browser use; smaller steps and more dimensions can increase computation and graph rendering time substantially. Oversized sweeps report the requested count, limit, and contributing axis counts; a suggested step or per-axis sample target helps reduce the request. Counting does not allocate sample arrays, and large products use exact integer arithmetic when the individual counts are representable. Oversized products are rejected before combination allocation; steps are never silently enlarged. Every dimension shares the same conservative 1,000 MiB retained-data budget, checked after each sample and including point values, residuals, sampling plans, combination bookkeeping, and container overhead. Dense Jacobians are computed when a point is inspected, rather than retained for every sample. If the dataset exceeds that limit, computation stops and the incomplete dataset is released; increase step sizes, narrow ranges, or reduce multistart guesses before retrying. Multiple roots and larger value dictionaries can exhaust the budget before reaching the point limit. The budget covers estimated retained sweep data; solver scratch space, worker transfers and Plotly allocations use additional memory. Individual combinations without solutions do not prevent the remaining combinations from being computed. Solver tolerance, iteration limits, and starting guesses are edited in **Solver settings**.

## Numerical method and limits

The independent engine is in [src/core](./src/core/). Names used in mathematical equations that are not declared parameters or built-in constants are inferred as unknowns, including names inside implicit equations such as `(Vin - Vout)/R = i*omega*C*Vout;`. An explicit unknown declaration can override the zero initial guess. Plot-only names still need a declaration or a defining equation. Simple assignments can then reconstruct computed quantities without adding independent numerical unknowns. Complete acyclic assignment chains such as `Ra = R1 + R2;` keep their direct evaluation path, independent of initial guesses and Newton's absolute tolerance. A fully linear system with coefficients fixed at the current sweep point is also solved directly using scaled Gaussian elimination with pivoting, including coupled cycles. This handles equations such as `2*x = p;` and cyclic linear assignments without Newton iterations. Zero or unsafe pivots, singular systems, unsupported expressions, and inaccurate direct candidates fall back to the numerical path. The original expressions, domains, bounds, and validity conditions are still checked.

Mixed systems use conservative assignment elimination plus simple linear isolation: `y = x - sin(y);` can reconstruct `x = y + sin(y)` while Newton solves the remaining equations in `y`. An isolated variable's coefficient must be fixed and nonzero at that sweep point; a coefficient depending on another numerical unknown is left implicit. The planner keeps whichever supported plan removes more variables, reconstructs eliminated values at every residual/Jacobian evaluation, and retains all values for plotting and inspection. Inclusive search bounds keep affected variables numerical during partial elimination to preserve endpoints despite rounding. This is a bounded greedy reduction, without general symbolic expansion, quadratic formulas, inverse-function branch enumeration, or a search for the largest solvable partial block. Preparation is repeated per sweep point; fixed-only assignment calculations are reused within that point's solve.

The remaining implicit system uses a central finite-difference Jacobian (one-sided at domain boundaries) and pivoted Gaussian elimination for a Newton step. Unknowns use characteristic scales from guesses/bounds and residual rows use fixed scales from the initial residual and Jacobian. A backtracking line search accepts only residual merit decreases. When Newton fails, adaptive Levenberg-style regularized normal equations provide safeguarded steps. Simple inclusive validity limits such as `x >= 0` or `x <= VDD` also guide search when the other side depends only on fixed or swept parameters. All conditions are checked at the root. Strict, compound, and unknown-dependent conditions are checked only after solving, so they may require more guesses or miss roots compared with explicit search bounds. Convergence requires both scaled and raw residual criteria and a small undamped Newton correction relative to the unknown scales and current values. Exact zero-residual roots remain valid even with a singular Jacobian. Failed solves never generate synthetic points. The inspector exposes raw residual infinity norm and computes the Jacobian at the selected point's actual parameter values. Mixed reduced systems report their numerical equations and unknowns; complete direct systems retain their full equation diagnostics. Direct `solve`/`roots` calls still include Jacobians by default; sweep samples store an empty matrix until inspected.

On the numerical path, deterministic Halton multistart guesses cover bounded intervals or a finite neighborhood of the initial guess. Roots are deduplicated in scaled unknown space. Sweeps seed each point with preceding roots and retain multistart discovery. Greedy one-to-one distance matching connects adjacent points, with a conservative maximum normalized distance; failed samples and large jumps split branch segments. Proven single-valued continuous assignment chains instead continue their unique branch across adjacent valid samples, avoiding artificial fragmentation when a frequency is many orders larger than its initial guess. Piecewise conditions and step functions retain the jump heuristic, and undefined samples break every path. Poles between sampled coordinates may require finer resolution. Closely spaced numerical roots can still be misassociated. Branch IDs identify plotted segments, not globally guaranteed mathematical branches. Flat or singular models can yield nonisolated roots. Neither exhaustive root discovery nor dynamic stability is claimed. Increase starts/resolution, improve guesses/scales, or add physically justified bounds/conditions when needed. Pseudo-arclength continuation is not implemented.

Sine is periodic, so different values of an unknown can produce the same output. With both `y` and `z` unknown, `z = sin(y);` alone is underdetermined. Adding `z = 0.5;` leaves infinitely many possible `y` values; finite multistart search can find some, without claiming all of them. The optional interval below restricts the solution to `y = pi/6`. Alternatively, `y = a; z = sin(y);` for a fixed parameter `a` directly determines both outputs.

```text
z = sin(y);
z = 0.5;
# Optional validity interval selects one sine branch:
y >= -pi/2;
y <= pi/2;
```

Piecewise functions evaluate the active branch at every candidate, including numerical derivative samples. Line search and regularization help at kinks but cannot guarantee convergence for discontinuous systems. Invalid expressions, singularities, nonconvergence, constraints, and failed plotted expressions appear in diagnostics. A red status dot indicates an error; click it for the message. A compact amber status indicates a partial sweep; click it to inspect failures. If one Y expression is undefined at a point, its curve has a gap while other valid expressions remain plotted. Unknown bounds reject roots outside their interval, so they can create gaps or shorten the plotted portion of a sweep even when the requested parameter range is larger. Save/export is explicit. A failed computation clears the previous successful result so a stale curve cannot be mistaken for a solution of the edited equations.

Diagnostics labels solved samples separately from plotted roots and calculation issues: one sampled coordinate may have several roots or failed plot expressions. Branch segments count connected curve portions. Grid progress counts finished combinations, including failed slices; its total elapsed time is separate from the displayed curve's solve time. Limits describe the retained sweep-data budget, not measured browser heap usage. Diagnostics memoizes the displayed curve summary and never scans all retained slices.

Long sweeps populate the graph as samples finish, with previews sent at most about every 200 ms between samples. Progress appears in the persistent status above the graph; the graph's slice row shows only the selected parameter values and position. The progress counter includes both successful and failed samples. Previews transfer only new points and diagnostics; worker messages and plot renders are bounded so a slow graph cannot queue unlimited snapshots. Numerical solving remains in one worker to preserve continuation seeds and branch matching, while the main thread plots results. Live plotting improves feedback and adds some transfer/rendering overhead; it does not accelerate a new numerical solve. Additional sweeps acknowledge each completed slice before starting the next so completed results cannot queue indefinitely.

The supplied [resistor-noise regression workspace](./src/core/fixtures/resistor-noise.json) is an acyclic assignment chain spanning resistances, frequency, and signals around `1e-13`. Its defined domain has `Stot = k*T/C = 4.14e-13`; `S3/S4 = R4/R3`, so `S3` and `S4` overlap exactly when `R3 = R4`. Hide either legend entry to inspect the other. Zero `R3` or `R4`, and simultaneous zero `R1` and `R2`, leave divisions by zero in the original equations. Those coordinates remain diagnostic gaps; positive resistance minima exclude them.

## Workspace JSON

Saved and exported workspaces use version 2. The ordered `tabs` array stores each tab's stable `id`, `title`, and exact `source` text, so equations, unknowns, parameters, elements, comments, whitespace, and unfinished drafts stay in their original tabs and positions. Loaded element definitions are included with the workspace. `settings` contains solver options and the saved sweep configuration. `set_time_axis` in tab source chooses the main traversal parameter, `plot` commands determine each curve's displayed coordinates, and `plot_x_transition` / `plot_y_transition` commands define graph reference lines. `settings.sweep.parameter` retains the saved sweep selection. Parameter ranges, starts, steps, and slice selections come from the declarations rather than duplicate JSON tables.

```json
{
  "format": "nonlinear-workbench",
  "version": 2,
  "name": "Example",
  "description": "",
  "tabs": [
    { "id": "model", "title": "Model", "source": "unknown y\nparameter x 0 1 -2 2 sweep\ny = 2*x;\nset_time_axis x\nplot y" }
  ],
  "settings": {
    "solver": { "tolerance": 1e-9, "iterations": 100, "starts": 12 },
    "sweep": { "mode": "free", "parameter": "x" }
  }
}
```

Only version 2 workspaces are supported for importing, saving, and exporting. Unversioned and previous workspace formats are rejected. Solver inputs are compiled from source on load, and invalid drafts remain visible with solving paused until corrected.

Impose/release sweep mode is deprecated and no longer offered in the settings controls. Existing version 2 workspaces retain their saved mode, imposed unknown, range, point count, logarithmic setting, and released parameter under `settings.sweep` for legacy compatibility; loading or saving does not silently convert them. To migrate, create a new equation workspace, copy the model, and configure a declared parameter with `sweep` and `set_time_axis`. Unknowns then solve normally at each parameter value.

## Tests

After building, `npm run test:browser` runs the standalone and development browser smoke checks on Windows with Microsoft Edge. It verifies offline solving, slice selection, point inspection, workspace export/import, and browser save/reload. Add `-- --screenshots` to capture desktop, settings, and narrow-screen previews in a temporary folder.

[src/core/solver.test.ts](./src/core/solver.test.ts) checks parsing and security rejection, engineering notation, linear/nonlinear known solutions, root deduplication, constraints and bounds, dependency cycles, piecewise boundaries, failed solves, branch gaps, arbitrary plot coordinates, legacy logarithmic/constrained sweep compatibility, transistor sweep coverage, the analytic zero-lambda NMOS result, and JSON imports.

Additional tests cover declaration defaults and positional options, invalid declarations, sweep selection, workspace format validation, plot-command validation across tabs, partial assignment elimination, inferred definitions, exact assignment dependencies, relative accuracy of tiny signals, singular and piecewise gaps, on-demand point Jacobians, parameter-derived sampling, center-first computation, separate continuation directions, prepended progress updates, analytical slices, memory limits, failed-slice recovery, worker backpressure, cancellation, ordinary sweep recomputation, secondary variable maintenance, and bounded plot scheduling.

The engine and worker are independent of React. Automatic differentiation can replace `jacobian`, advanced continuation can replace branch matching, and future small-signal analysis can consume the returned physical Jacobian without changing equation input.

