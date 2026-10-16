/*
 * ==================================================================
 *  Generalized ARQ Protocol Simulator
 *  Data Link Layer flow control: Stop-and-Wait, Go-Back-N and
 *  Selective Repeat implemented behind one common interface.
 * ==================================================================
 *
 *  Channel model (discrete time units):
 *   - the sender puts at most one frame on the link per time unit
 *   - every frame / ACK needs PROPAGATION_DELAY units to cross
 *   - a frame or ACK selected by the user is lost on its first trip
 *   - a timer that expires before its ACK returns triggers recovery
 */
#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <set>
#include <deque>
#include <algorithm>
#include <cstdlib>
#include <cctype>

using namespace std;

const int PROPAGATION_DELAY = 2;   // one-way delay of a frame or an ACK
const int TIMEOUT_INTERVAL  = 6;   // must exceed the round-trip time (4)
const int MAX_FRAMES        = 64;
const int MAX_SEQ_BITS      = 8;
const int MAX_SIM_TIME      = 100000;

string str(int value) {
    ostringstream out;
    out << value;
    return out.str();
}

enum EventType { FRAME_ARRIVAL, ACK_ARRIVAL, TIMER_EXPIRY };

struct Event {
    int time;        // instant at which the event fires
    EventType type;
    int frame;       // frame carried, acknowledged or timed out
    int ackNo;       // sequence number written inside an ACK
    bool lost;       // dropped by the channel
    int timerId;     // timer instance (stale timers are ignored)
};

struct Config {
    int protocol;
    int totalFrames;
    int seqBits;
    int senderWindow;
    int receiverWindow;
    set<int> lostFrames;
    set<int> lostAcks;
};

struct Statistics {
    int transmissions;
    int retransmissions;
    int delivered;
    int discarded;
    int framesLost;
    int acksLost;
    int timeouts;
    int totalTime;
};

/* ------------------ Common interface for every ARQ protocol ------------------ */
class ARQProtocol {
protected:
    Config cfg;
    Statistics stats;
    vector<Event> channel;      // frames, ACKs and timers that are pending
    vector<int> sendCount;      // number of times each frame was sent
    int clock;
    int seqSpace;               // 2^m sequence numbers
    int nextTimerId;

    int seqOf(int frame) const { return frame % seqSpace; }

    void log(const string& who, const string& msg) {
        cout << "[t=" << setw(3) << clock << "] " << who
             << string(8 - who.size(), ' ') << " : " << msg << "\n";
    }

    void transmitFrame(int frame) {
        bool isRetransmission = sendCount[frame] > 0;
        sendCount[frame]++;
        stats.transmissions++;
        if (isRetransmission) stats.retransmissions++;

        bool lost = cfg.lostFrames.count(frame) > 0;
        if (lost) cfg.lostFrames.erase(frame);          // lost on first trip only

        Event e = { clock + PROPAGATION_DELAY, FRAME_ARRIVAL, frame, seqOf(frame), lost, 0 };
        channel.push_back(e);
        log("SENDER", "Frame " + str(frame) + " (seq " + str(seqOf(frame)) + ") "
                      + (isRetransmission ? "retransmitted" : "transmitted"));
    }

    void transmitAck(int frame, int ackNo) {
        bool lost = cfg.lostAcks.count(frame) > 0;
        if (lost) cfg.lostAcks.erase(frame);

        Event e = { clock + PROPAGATION_DELAY, ACK_ARRIVAL, frame, ackNo, lost, 0 };
        channel.push_back(e);
        log("RECEIVER", "ACK " + str(ackNo) + " generated for Frame " + str(frame));
    }

    int startTimer(int frame) {
        Event e = { clock + TIMEOUT_INTERVAL, TIMER_EXPIRY, frame, 0, false, nextTimerId };
        channel.push_back(e);
        return nextTimerId++;
    }

    string windowText(int base, int size) const {
        if (base >= cfg.totalFrames) return "all frames acknowledged";
        int last = min(base + size, cfg.totalFrames) - 1;
        return "window slides to Frames " + str(base) + "-" + str(last);
    }

    void processEvents() {
        vector<Event> due, pending;
        for (size_t i = 0; i < channel.size(); i++) {
            if (channel[i].time == clock) due.push_back(channel[i]);
            else pending.push_back(channel[i]);
        }
        channel = pending;

        // arrivals on the channel are handled before timers firing at the same instant
        for (size_t i = 0; i < due.size(); i++) {
            const Event& e = due[i];
            if (e.type == FRAME_ARRIVAL) {
                if (e.lost) {
                    stats.framesLost++;
                    log("CHANNEL", "Frame " + str(e.frame) + " lost - frame loss detected");
                } else {
                    receiveFrame(e.frame);
                }
            } else if (e.type == ACK_ARRIVAL) {
                if (e.lost) {
                    stats.acksLost++;
                    log("CHANNEL", "ACK " + str(e.ackNo) + " for Frame " + str(e.frame) + " lost");
                } else {
                    receiveAck(e.frame, e.ackNo);
                }
            }
        }
        for (size_t i = 0; i < due.size(); i++) {
            if (due[i].type == TIMER_EXPIRY) onTimeout(due[i].frame, due[i].timerId);
        }
    }

    // protocol specific behaviour
    virtual void sendNext() = 0;                          // sender: put one frame on the link
    virtual void receiveFrame(int frame) = 0;             // receiver: acceptance rules
    virtual void receiveAck(int frame, int ackNo) = 0;    // sender: acknowledgement handling
    virtual void onTimeout(int frame, int timerId) = 0;   // sender: error recovery
    virtual bool finished() const = 0;

public:
    ARQProtocol(const Config& c) : cfg(c), stats(), clock(0), nextTimerId(1) {
        seqSpace = 1 << c.seqBits;
        sendCount.assign(c.totalFrames, 0);
    }
    virtual ~ARQProtocol() {}
    virtual string name() const = 0;

    void run() {
        cout << "Protocol: " << name() << "\n";
        cout << "Sequence numbers: 0-" << seqSpace - 1 << " (m = " << cfg.seqBits << ")\n";
        cout << "Sender window: " << cfg.senderWindow
             << " | Receiver window: " << cfg.receiverWindow << "\n";
        cout << "Propagation delay: " << PROPAGATION_DELAY
             << " | Timeout: " << TIMEOUT_INTERVAL << " (time units)\n\n";

        while (clock <= MAX_SIM_TIME) {
            processEvents();
            if (finished()) break;
            sendNext();
            clock++;
        }
        stats.totalTime = clock;
        printSummary();
    }

    void printSummary() const {
        // useful frames / total transmissions, rounded to two decimals
        long long scaled = stats.transmissions > 0
            ? (20000LL * stats.delivered + stats.transmissions) / (2LL * stats.transmissions) : 0;
        cout << "\n========== PERFORMANCE SUMMARY ==========\n";
        cout << "Protocol                      : " << name() << "\n";
        cout << "Successfully delivered frames : " << stats.delivered << "\n";
        cout << "Total transmission attempts   : " << stats.transmissions << "\n";
        cout << "Total retransmissions         : " << stats.retransmissions << "\n";
        cout << "Total frames discarded        : " << stats.discarded << "\n";
        cout << "Frames lost in channel        : " << stats.framesLost << "\n";
        cout << "ACKs lost in channel          : " << stats.acksLost << "\n";
        cout << "Timeouts                      : " << stats.timeouts << "\n";
        cout << "Total simulated time          : " << stats.totalTime << " time units\n";
        cout << "Efficiency                    : " << scaled / 100 << "."
             << setw(2) << setfill('0') << scaled % 100 << setfill(' ') << " %\n";
    }
};

/* --------------------------------- Stop-and-Wait --------------------------------- */
class StopAndWait : public ARQProtocol {
    int current;     // sender: frame waiting for its ACK
    bool waiting;    // sender: a frame is outstanding
    int timerId;     // sender: active timer (0 = stopped)
    int expected;    // receiver: next frame expected

public:
    StopAndWait(const Config& c)
        : ARQProtocol(c), current(0), waiting(false), timerId(0), expected(0) {}
    string name() const { return "Stop-and-Wait"; }

protected:
    void sendNext() {
        if (waiting || current >= cfg.totalFrames) return;
        transmitFrame(current);
        timerId = startTimer(current);
        waiting = true;
    }

    void receiveFrame(int frame) {
        if (seqOf(frame) == seqOf(expected)) {
            stats.delivered++;
            log("RECEIVER", "Frame " + str(frame) + " received successfully");
            expected++;
        } else {
            stats.discarded++;
            log("RECEIVER", "Duplicate Frame " + str(frame) + " discarded");
        }
        transmitAck(frame, seqOf(expected));          // ACK names the next expected frame
    }

    void receiveAck(int /* frame */, int ackNo) {
        if (waiting && ackNo == seqOf(current + 1)) {
            timerId = 0;
            waiting = false;
            current++;
            log("SENDER", "ACK " + str(ackNo) + " received, timer stopped");
        } else {
            log("SENDER", "Duplicate ACK " + str(ackNo) + " ignored");
        }
    }

    void onTimeout(int frame, int id) {
        if (!waiting || id != timerId) return;        // stale timer
        stats.timeouts++;
        log("TIMER", "Timeout occurred for Frame " + str(frame));
        log("SENDER", "Retransmitting current unacknowledged Frame " + str(frame));
        timerId = 0;
        waiting = false;                              // allow sendNext() to resend it
    }

    bool finished() const { return current >= cfg.totalFrames; }
};

/* ----------------------------------- Go-Back-N ----------------------------------- */
class GoBackN : public ARQProtocol {
    int base;        // sender: oldest unacknowledged frame
    int nextFrame;   // sender: next frame to transmit
    int timerId;     // sender: single timer for the oldest outstanding frame
    int expected;    // receiver: next in-order frame

public:
    GoBackN(const Config& c)
        : ARQProtocol(c), base(0), nextFrame(0), timerId(0), expected(0) {}
    string name() const { return "Go-Back-N"; }

protected:
    void sendNext() {
        if (nextFrame < base + cfg.senderWindow && nextFrame < cfg.totalFrames) {
            transmitFrame(nextFrame);
            if (timerId == 0) timerId = startTimer(base);
            nextFrame++;
        }
    }

    void receiveFrame(int frame) {
        if (seqOf(frame) == seqOf(expected)) {
            stats.delivered++;
            log("RECEIVER", "Frame " + str(frame) + " received successfully");
            expected++;
            transmitAck(frame, seqOf(expected));      // cumulative ACK
        } else {
            stats.discarded++;
            log("RECEIVER", "Out-of-order Frame " + str(frame) + " discarded (expecting Frame "
                            + str(expected) + ")");
            if (expected > 0) transmitAck(expected - 1, seqOf(expected));
        }
    }

    void receiveAck(int frame, int ackNo) {
        if (frame >= base) {
            log("SENDER", "Cumulative ACK " + str(ackNo) + " received (Frames up to "
                          + str(frame) + " acknowledged)");
            base = frame + 1;
            nextFrame = max(nextFrame, base);
            if (base == nextFrame) timerId = 0;
            else timerId = startTimer(base);
            log("SENDER", windowText(base, cfg.senderWindow));
        } else {
            log("SENDER", "Duplicate ACK " + str(ackNo) + " ignored");
        }
    }

    void onTimeout(int /* frame */, int id) {
        if (id != timerId) return;                    // stale timer
        stats.timeouts++;
        log("TIMER", "Timeout occurred for Frame " + str(base));
        log("SENDER", "Retransmitting outstanding Frames " + str(base) + "-" + str(nextFrame - 1));
        nextFrame = base;                             // go back to the oldest unacked frame
        timerId = 0;
    }

    bool finished() const { return base >= cfg.totalFrames; }
};

/* -------------------------------- Selective Repeat -------------------------------- */
class SelectiveRepeat : public ARQProtocol {
    int base;                  // sender: oldest unacknowledged frame
    int nextFrame;             // sender: next new frame to transmit
    vector<bool> acked;        // sender: individually acknowledged frames
    vector<int> timerIds;      // sender: one timer per outstanding frame
    deque<int> resendQueue;    // sender: frames whose timer expired
    int rcvBase;               // receiver: start of the receiver window
    vector<bool> buffered;     // receiver: frames held in the buffer

public:
    SelectiveRepeat(const Config& c)
        : ARQProtocol(c), base(0), nextFrame(0), acked(c.totalFrames, false),
          timerIds(c.totalFrames, 0), rcvBase(0), buffered(c.totalFrames, false) {}
    string name() const { return "Selective Repeat"; }

protected:
    void sendNext() {
        while (!resendQueue.empty()) {
            int frame = resendQueue.front();
            resendQueue.pop_front();
            if (acked[frame]) continue;
            transmitFrame(frame);
            timerIds[frame] = startTimer(frame);
            return;
        }
        if (nextFrame < base + cfg.senderWindow && nextFrame < cfg.totalFrames) {
            transmitFrame(nextFrame);
            timerIds[nextFrame] = startTimer(nextFrame);
            nextFrame++;
        }
    }

    void receiveFrame(int frame) {
        if (frame >= rcvBase && frame < rcvBase + cfg.receiverWindow) {
            if (buffered[frame]) {
                stats.discarded++;
                log("RECEIVER", "Duplicate Frame " + str(frame) + " discarded");
            } else if (frame == rcvBase) {
                buffered[frame] = true;
                log("RECEIVER", "Frame " + str(frame) + " received successfully");
            } else {
                buffered[frame] = true;
                log("RECEIVER", "Out-of-order Frame " + str(frame) + " buffered");
            }
            transmitAck(frame, seqOf(frame));         // individual ACK
            while (rcvBase < cfg.totalFrames && buffered[rcvBase]) {
                stats.delivered++;
                log("RECEIVER", "Frame " + str(rcvBase) + " delivered to network layer");
                rcvBase++;
            }
        } else if (frame < rcvBase) {
            stats.discarded++;
            log("RECEIVER", "Duplicate Frame " + str(frame) + " discarded (already delivered)");
            transmitAck(frame, seqOf(frame));         // re-ACK so the sender can advance
        } else {
            stats.discarded++;
            log("RECEIVER", "Frame " + str(frame) + " outside receiver window discarded");
        }
    }

    void receiveAck(int frame, int ackNo) {
        if (!acked[frame]) {
            acked[frame] = true;
            timerIds[frame] = 0;
            log("SENDER", "ACK " + str(ackNo) + " received for Frame " + str(frame)
                          + ", timer stopped");
            if (frame == base) {
                while (base < cfg.totalFrames && acked[base]) base++;
                log("SENDER", windowText(base, cfg.senderWindow));
            }
        } else {
            log("SENDER", "Duplicate ACK " + str(ackNo) + " ignored");
        }
    }

    void onTimeout(int frame, int id) {
        if (acked[frame] || timerIds[frame] != id) return;   // stale timer
        stats.timeouts++;
        timerIds[frame] = 0;
        log("TIMER", "Timeout occurred for Frame " + str(frame));
        log("SENDER", "Selectively retransmitting only Frame " + str(frame));
        resendQueue.push_back(frame);
    }

    bool finished() const { return base >= cfg.totalFrames; }
};

/* ------------------------------ Protocol selection ------------------------------ */
ARQProtocol* createProtocol(const Config& cfg) {
    switch (cfg.protocol) {
        case 1:  return new StopAndWait(cfg);
        case 2:  return new GoBackN(cfg);
        default: return new SelectiveRepeat(cfg);
    }
}

string validateConfig(const Config& cfg) {
    if (cfg.totalFrames < 1 || cfg.totalFrames > MAX_FRAMES)
        return "Number of frames must be between 1 and " + str(MAX_FRAMES) + ".";
    if (cfg.seqBits < 1 || cfg.seqBits > MAX_SEQ_BITS)
        return "Sequence number bits must be between 1 and " + str(MAX_SEQ_BITS) + ".";

    int space = 1 << cfg.seqBits;
    if (cfg.protocol == 2 && (cfg.senderWindow < 1 || cfg.senderWindow > space - 1))
        return "Go-Back-N requires 1 <= Ws <= 2^m - 1 = " + str(space - 1)
               + " (given Ws = " + str(cfg.senderWindow) + ").";
    if (cfg.protocol == 3) {
        if (cfg.senderWindow < 1 || cfg.senderWindow > space / 2)
            return "Selective Repeat requires 1 <= Ws <= 2^(m-1) = " + str(space / 2)
                   + " (given Ws = " + str(cfg.senderWindow) + ").";
        if (cfg.receiverWindow < 1 || cfg.receiverWindow > space / 2)
            return "Selective Repeat requires 1 <= Wr <= 2^(m-1) = " + str(space / 2)
                   + " (given Wr = " + str(cfg.receiverWindow) + ").";
    }
    return "";
}

/* ---------------------------------- User input ---------------------------------- */
int readInt(const string& prompt) {
    cout << prompt;
    string line;
    if (!getline(cin, line)) return 0;
    return atoi(line.c_str());
}

set<int> readList(const string& prompt) {
    cout << prompt;
    string line;
    getline(cin, line);
    for (size_t i = 0; i < line.size(); i++) {
        if (!isdigit((unsigned char)line[i])) line[i] = ' ';
    }
    set<int> values;
    istringstream in(line);
    int value;
    while (in >> value) values.insert(value);
    return values;
}

void dropUnknown(set<int>& values, int totalFrames, const string& what) {
    vector<int> unknown;
    for (set<int>::iterator it = values.begin(); it != values.end(); ++it) {
        if (*it >= totalFrames) unknown.push_back(*it);
    }
    for (size_t i = 0; i < unknown.size(); i++) {
        cout << "Warning: " << what << " " << unknown[i] << " does not exist and is ignored\n";
        values.erase(unknown[i]);
    }
}

void printError(const string& message) {
    cout << "\nERROR: Invalid configuration!\n" << message << "\nSimulation aborted.\n";
}

int main() {
    Config cfg;
    cout << "========== GENERALIZED ARQ SIMULATOR ==========\n\n";
    cout << "Select ARQ Protocol:\n";
    cout << "1. Stop-and-Wait\n";
    cout << "2. Go-Back-N\n";
    cout << "3. Selective Repeat\n\n";

    cfg.protocol = readInt("Enter your choice: ");
    if (cfg.protocol < 1 || cfg.protocol > 3) {
        printError("Protocol choice must be 1, 2 or 3.");
        return 1;
    }
    cout << "\n";

    cfg.totalFrames = readInt("Enter total number of frames: ");
    cfg.seqBits = readInt("Enter sequence number bits: ");
    if (cfg.protocol == 1) {
        cfg.senderWindow = cfg.receiverWindow = 1;
        cout << "Sender and receiver window fixed to 1 for Stop-and-Wait\n";
    } else if (cfg.protocol == 2) {
        cfg.senderWindow = readInt("Enter sender window size: ");
        cfg.receiverWindow = 1;
        cout << "Receiver window fixed to 1 for Go-Back-N\n";
    } else {
        cfg.senderWindow = readInt("Enter sender window size: ");
        cfg.receiverWindow = readInt("Enter receiver window size: ");
    }

    cout << "\nConfigure channel errors:\n";
    cfg.lostFrames = readList("Enter frame numbers to be lost: ");
    cfg.lostAcks = readList("Enter ACK numbers to be lost: ");

    string error = validateConfig(cfg);
    if (!error.empty()) {
        printError(error);
        return 1;
    }
    dropUnknown(cfg.lostFrames, cfg.totalFrames, "Frame");
    dropUnknown(cfg.lostAcks, cfg.totalFrames, "ACK");

    cout << "\n========== TRANSMISSION LOG ==========\n\n";
    ARQProtocol* protocol = createProtocol(cfg);
    protocol->run();
    delete protocol;
    return 0;
}
