'use strict';
// Groups and descriptions for the 70 presets the Micro Plus ships with, matched by name.
// Written from each preset's stored amp and effects, using the model names the editor shows. Where the
// Mustang GT has a preset of the same name, Fender's notes on its sound informed the wording.
const factoryPresetGroups = [
  {"name": "Clean", "presets": {
    "Acoustic Gtr Sim": "Makes an electric guitar sound closer to an acoustic, with compression, chorus and a large hall.",
    "Country Twang": "Very clean '65 Deluxe with compression, delay and spring reverb, for country picking.",
    "Surfy": "'59 Bassman with spring reverb, for surf lines.",
    "Buckaroo": "Barely any gain on a '65 Deluxe, with compression to even out the strings and spring reverb, for classic country.",
    "Pop Chorus": "Clean '65 Twin with compression, chorus and a large hall, for 80s pop.",
    "Jazz Clean": "Warm, clean '65 Twin with compression and a large hall, which sits back and leaves room for the music.",
    "DI Funk": "Clean preamp with no amp character, plus compression, for tight funk rhythm.",
    "Sun Session": "Clean Excelsior with compression and tape delay, for rockabilly with an authentic echo.",
    "Rock a Billy": "'57 Deluxe with a little tape delay, for classic rhythm playing."
  }},
  {"name": "Blues and crunch", "presets": {
    "Driven Deluxe": "'65 Deluxe pushed by a Greenbox overdrive pedal, with spring reverb.",
    "Tweed Sugar": "'57 Twin with compression, a little dirty, for 70s-style rock and roll.",
    "Tweed Blues": "'57 Twin at full gain with a Greenbox overdrive pedal and spring reverb.",
    "Brit Pop": "British AC30 at moderate gain, for jangly chords.",
    "Blues 1951": "Excelsior turned up high with compression, for raw Chicago-style blues rhythm.",
    "Derek Champ": "Small '57 Champ driven hard in a large hall, for slow, relaxed rhythm playing.",
    "Cranked Prince": "Small '65 Princeton at full gain with spring reverb, overdriven with singing sustain.",
    "Sustaind": "Clean '65 Twin with a sustain pedal and spring reverb, so notes ring on.",
    "Fuzzy Deluxe": "'65 Deluxe with a Vari Fuzz pedal, delay and spring reverb.",
    "Spoonful": "British Plexi near full gain with a small room, for gritty blues in the style of 60s Britain.",
    "Bassman Beef": "'59 Bassman with a Greenbox overdrive pedal, thick and punchy."
  }},
  {"name": "Rock", "presets": {
    "70S Rock": "British Plexi at full gain in a large hall, for classic hard rock.",
    "80S Rock": "British 800 at full gain with a Greenbox overdrive pedal and a large hall.",
    "90S Rock": "Rectifier at moderate gain, for fat palm-muted riffs.",
    "Super Live": "Super Sonic with plenty of gain, delay and a modulated hall, for hot, sizzling live tones.",
    "Boosted Brit": "British Plexi boosted by a Mythic Drive pedal, with tape delay.",
    "Pawn King": "Silvertone with a big fuzz pedal, for garage rock that sounds about to fall apart.",
    "Angry Rodent": "Blackbox distortion pedal into a low-gain British 800, for thick, fuzzy alternative rock.",
    "Early Eddie": "British Plexi at full gain with phaser and EQ, for explosive, showy rock solos.",
    "Loud As Leeds": "British DR103 at full gain in a large hall, an aggressive amp pushed to its limit.",
    "Evil Bassman": "'59 Bassman boosted by a Blackbox distortion pedal, wild and raw."
  }},
  {"name": "Leads and metal", "presets": {
    "Stadium Lead": "Rectifier with chorus, delay and a large hall, for arena solos.",
    "Metal 2000": "Modern 5150-style high gain, a heavy machine for tight metal riffs.",
    "BB15 Solo": "Bassbreaker 15 at high gain with tape delay and a large hall, for solos.",
    "Uber Metal": "Uberschall high-gain amp, for heavy modern metal.",
    "Octobot": "British 800 near full gain with an Octobot octave pedal, for thick leads.",
    "Fired Up Lead": "BE100 at full gain with mod delay and a large hall.",
    "Super Burn": "Super Sonic with overdrive, phaser and tape delay, for swirling metal leads.",
    "Single Scoop": "5150-style high gain shaped by a five-band EQ, for scooped metal rhythm."
  }},
  {"name": "Echoes and space", "presets": {
    "Swirling Echoes": "Clean '65 Twin with compression, mod delay and a modulated hall.",
    "Stereo Delay": "'57 Deluxe with a Mythic Drive pedal, mod delay and a large hall.",
    "Wild Nocturne": "Crisp '65 Twin that seems to swirl around you, with compression, flanger, mod delay and a modulated hall.",
    "Echo Dome": "Clean '65 Twin with compression, chorus, delay and spring reverb.",
    "Broken": "Bassbreaker 15 with a Mythic Drive pedal, reverse delay and a modulated hall.",
    "Year 2290": "British AC30 with compression, mod delay and a modulated hall, for spacey parts.",
    "Pigs Can Fly": "Big fuzz into a British DR103 with chorus, delay and a large hall, for rhythmic delay patterns.",
    "Irish Anthems": "British AC30 with compression, mod delay and a large hall, for ringing arena chords."
  }},
  {"name": "Chorus, tremolo and phaser", "presets": {
    "Hey Jimi": "Fuzz into a British Plexi with harmonic tremolo, tape delay and a large hall, for psychedelic rock.",
    "Twin Trem": "'65 Twin with tremolo and spring reverb, for a classic pulsing clean sound.",
    "Vibra Drive": "'65 Twin with a Greenbox overdrive pedal, Vibratone and spring reverb.",
    "Harmonic Vibrato": "British DR103 with a Mythic Drive pedal, harmonic tremolo and spring reverb.",
    "Lavender Rain": "Clean '65 Twin with compression, chorus, delay and a large hall, for lush chords.",
    "Dirty Flanger": "British Plexi with a Greenbox overdrive pedal and flanger, for 70s hard rock.",
    "Phased": "'65 Twin with compression, phaser and spring reverb.",
    "Blk Hole Vibe": "'59 Bassman through a Vibratone in a large hall, for shimmering high arpeggios.",
    "Vintage Throb": "Low-gain British Plexi with a Mythic Drive pedal, tremolo, delay and a modulated hall.",
    "Filtered Echoes": "'65 Twin with an envelope filter, delay and spring reverb, for funky vocal-like notes."
  }},
  {"name": "Just the amp", "presets": {
    "65 Twin Reverb": "'65 Twin on its own, clean, with spring reverb.",
    "65 Dlx Reverb": "'65 Deluxe on its own, with spring reverb.",
    "65 Princ Reverb": "'65 Princeton on its own, with spring reverb.",
    "57 Champ": "Tiny '57 Champ on its own, in a small room.",
    "57 Dlx Fat": "'57 Deluxe turned up for a fat tweed sound, in a small room.",
    "57 Twin": "'57 Twin at full gain on its own, in a large hall.",
    "Silver Tone": "Silvertone on its own, with spring reverb.",
    "Brit Colour": "British OR120 on its own in a large hall, thick and growling for sludgy riffs.",
    "Brit Stk Clean": "British DR103 on its own at moderate gain, in a large hall.",
    "FBE100": "BE100 on its own, in a large hall.",
    "BB15 Low": "Bassbreaker 15 on its low-gain setting, in a small room.",
    "BB15 Mid": "Bassbreaker 15 on its medium-gain setting, in a small room.",
    "BB15 Hi": "Bassbreaker 15 on its high-gain setting, in a small room.",
    "Studio Pre": "Clean preamp with no amp character, in a large hall."
  }}
];
