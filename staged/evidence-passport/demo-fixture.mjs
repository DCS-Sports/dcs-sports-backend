/**
 * evidence-passport/demo-fixture.mjs — the demo match's reviewed incidents.
 * FIXTURE, and says so: this feeds /match/demo (CW1) and tests. Real matches use the
 * gateway's incident source. One CONFIRMED + one REJECTED camera event, per acceptance.
 */
export const demoMatch = {
  matchId: 'demo',
  title: 'DCS Demo Match · Hisar Titans v Karnal Kings',
  venue: 'DCS Ground 1, Hisar',
  date: '2026-07-16',
  fixture: true,
};

export const demoIncidents = [
  {
    deliveryId: 'd-142', overBall: '14.2',
    sourceCameraIds: ['cam-straight', 'cam-legside'],
    mediaHashes: [
      { cameraId: 'cam-straight', sha256: 'c1a9f4b8de301276a55f1c2e9d84b0a733e5c6f2481907dab2ce64f01a9b3d55' },
      { cameraId: 'cam-legside',  sha256: '7e2d90c4a1b8f6533ac2ee19d0745b6c88f13a29e4d5c7601b3f2a8d94e60c17' },
    ],
    audioHash: '5f8c2a1e9b4d7306c1f0a3852ed6b94717c4e0a2d8b5f6931c2e7d40a1b8c563',
    calibrationVersion: 'cal-2026.07.15-g1', modelVersion: 'boundary-est-0.3',
    confidence: 0.78, framesUsed: [{ cameraId: 'cam-straight', from: 18832, to: 18869 }],
    onFieldCall: 'four (signalled by on-field umpire)',
    reviewReason: 'camera boundary estimate disagreed with scorer entry (fusion DISAGREE)',
    evidenceLabel: 'boundary-camera estimate: ball cleared the rope on the full',
    reviewer: 'Match Official R. Sharma',
    decision: 'confirmed',           // official CONFIRMED the camera estimate → six
    corrections: [{ field: 'runs', from: '4', to: '6', by: 'Match Official R. Sharma', at: '2026-07-16T14:22:31Z' }],
    decidedAt: '2026-07-16T14:22:31Z',
  },
  {
    deliveryId: 'd-173', overBall: '17.3',
    sourceCameraIds: ['cam-straight'],
    mediaHashes: [{ cameraId: 'cam-straight', sha256: 'a4b7c2d9e1f8306512bc94d7e0a3f6852c1b9e4d70a2f5c863d1e9b40c7a2f88' }],
    audioHash: '9d3e7a1c5b8f2604e2a9c4d1f7b0e58312c6a9f4d8e5b7062a1c3f9e4d70b851',
    calibrationVersion: 'cal-2026.07.15-g1', modelVersion: 'edge-audio-est-0.2',
    confidence: 0.61, framesUsed: [{ cameraId: 'cam-straight', from: 22410, to: 22436 }],
    onFieldCall: 'not out (appeal for caught behind)',
    reviewReason: 'audio spike near bat-pass window; fielding side review',
    evidenceLabel: 'audio-sync estimate: possible edge, low confidence',
    reviewer: 'Match Official R. Sharma',
    decision: 'rejected',            // official REJECTED the low-confidence estimate → stays not out
    corrections: [],
    decidedAt: '2026-07-16T15:03:12Z',
  },
];

export const demoSource = {
  async getMatch(id) { return id === 'demo' ? demoMatch : null; },
  async getIncidents(id) { return id === 'demo' ? demoIncidents : []; },
};
