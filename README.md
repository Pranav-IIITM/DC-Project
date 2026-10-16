# Generalized ARQ Protocol Simulator

Interactive simulator for the Data Link Layer flow-control protocols **Stop-and-Wait**, **Go-Back-N** and **Selective Repeat** (DC Lab, Assignment 09 & 10).

A single C++ program implements all three protocols behind one common interface. The website shows that source code, "compiles" and runs it in the browser with line-by-line highlighting, and animates what happens on the channel.

## Features

- **C++ source viewer**: the full `arq_simulator.cpp` with syntax highlighting. During a run, the executing line and its enclosing block (loop, `if` or function) are highlighted, with loop-iteration badges.
- **Compile & run**: the terminal shows the compile step and runs the program with the configured stdin. Its output matches the real compiled binary exactly.
- **Channel view**: sender and receiver frame buffers, sliding windows, per-frame timers, and animated frames, ACKs and losses.
- **Space-time diagram**: the classic timing diagram with losses, timeouts, buffering and deliveries.
- **Variables watch and live metrics**: sender/receiver state and counters update as the program runs.
- **Assignment test cases**: one-click presets for all 7 test conditions, including invalid configurations.
- **Compare tab**: side-by-side retransmissions, deliveries, simulated time and efficiency, a test-case matrix, and downloadable execution logs.
- **Theory tab**: protocol rules, how protocol selection works, and answers to the assignment questions.

## Running the C++ program

```bash
g++ -std=c++17 -Wall -Wextra -O2 cpp/arq_simulator.cpp -o arq_simulator
./arq_simulator
```

Sample session (Go-Back-N):

```
Enter your choice: 2
Enter total number of frames: 10
Enter sequence number bits: 3
Enter sender window size: 4
Enter frame numbers to be lost: 3, 7
Enter ACK numbers to be lost: 5
```

### Channel model

- The sender puts at most one frame on the link per time unit.
- Frames and ACKs take 2 time units to cross the channel; the timeout is 6 time units.
- A frame or ACK chosen for loss is dropped only on its first trip. ACK numbers refer to the frame being acknowledged.

## Running the website locally

The site is static (HTML, CSS and JavaScript, no build step). Serve the folder over HTTP:

```bash
python -m http.server 5173
```

Then open http://localhost:5173.

## Project structure

```
index.html              page layout
assets/css/style.css    styles (light theme)
assets/js/engine.js     execution engine mirroring the C++ program
assets/js/highlight.js  C++ syntax highlighting and block detection
assets/js/app.js        UI, player, animations and comparison
cpp/arq_simulator.cpp   generalized ARQ simulator (C++)
```
