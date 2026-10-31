'use strict';
// Groups and descriptions for the 70 presets the Micro Plus ships with, matched by name.
// Written from each preset's stored amp and effects, using the model names the editor shows. Where the
// Mustang GT has a preset of the same name, Fender's notes on its sound informed the wording.
// Artists are a rough idea of who each preset is close to: a judgement from its settings and name, not from
// Fender or from listening. Presets with no reasonably well-known match have none.
const factoryPresetGroups = [
  {"name": "Clean", "presets": {
    "Acoustic Gtr Sim": {"description": "Makes an electric guitar sound closer to an acoustic, with compression, chorus and a large hall."},
    "Country Twang": {"description": "Very clean '65 Deluxe with compression, delay and spring reverb, for country picking.", "artists": ["Brad Paisley", "Vince Gill"]},
    "Surfy": {"description": "'59 Bassman with spring reverb, for surf lines.", "artists": ["Dick Dale", "The Ventures"]},
    "Buckaroo": {"description": "Barely any gain on a '65 Deluxe, with compression to even out the strings and spring reverb, for classic country.", "artists": ["Buck Owens and the Buckaroos"]},
    "Pop Chorus": {"description": "Clean '65 Twin with compression, chorus and a large hall, for 80s pop.", "artists": ["The Police", "The Cure"]},
    "Jazz Clean": {"description": "Warm, clean '65 Twin with compression and a large hall, which sits back and leaves room for the music.", "artists": ["Wes Montgomery", "Joe Pass"]},
    "DI Funk": {"description": "Clean preamp with no amp character, plus compression, for tight funk rhythm.", "artists": ["Chic", "Earth, Wind & Fire"]},
    "Sun Session": {"description": "Clean Excelsior with compression and tape delay, for rockabilly with an authentic echo.", "artists": ["Elvis Presley", "Johnny Cash"]},
    "Rock a Billy": {"description": "'57 Deluxe with a little tape delay, for classic rhythm playing.", "artists": ["Stray Cats", "Eddie Cochran"]}
  }},
  {"name": "Blues and crunch", "presets": {
    "Driven Deluxe": {"description": "'65 Deluxe pushed by a Greenbox overdrive pedal, with spring reverb.", "artists": ["John Mayer", "Stevie Ray Vaughan"]},
    "Tweed Sugar": {"description": "'57 Twin with compression, a little dirty, for 70s-style rock and roll.", "artists": ["The Rolling Stones", "Faces"]},
    "Tweed Blues": {"description": "'57 Twin at full gain with a Greenbox overdrive pedal and spring reverb.", "artists": ["The Black Crowes", "Neil Young"]},
    "Brit Pop": {"description": "British AC30 at moderate gain, for jangly chords.", "artists": ["Oasis", "Blur"]},
    "Blues 1951": {"description": "Excelsior turned up high with compression, for raw Chicago-style blues rhythm.", "artists": ["Muddy Waters", "Howlin' Wolf"]},
    "Derek Champ": {"description": "Small '57 Champ driven hard in a large hall, for slow, relaxed rhythm playing.", "artists": ["Derek and the Dominos"]},
    "Cranked Prince": {"description": "Small '65 Princeton at full gain with spring reverb, overdriven with singing sustain.", "artists": ["The Black Keys"]},
    "Sustaind": {"description": "Clean '65 Twin with a sustain pedal and spring reverb, so notes ring on.", "artists": ["Santana", "David Gilmour"]},
    "Fuzzy Deluxe": {"description": "'65 Deluxe with a Vari Fuzz pedal, delay and spring reverb.", "artists": ["The Rolling Stones", "The White Stripes"]},
    "Spoonful": {"description": "British Plexi near full gain with a small room, for gritty blues in the style of 60s Britain.", "artists": ["Cream"]},
    "Bassman Beef": {"description": "'59 Bassman with a Greenbox overdrive pedal, thick and punchy.", "artists": ["ZZ Top", "Stevie Ray Vaughan"]}
  }},
  {"name": "Rock", "presets": {
    "70S Rock": {"description": "British Plexi at full gain in a large hall, for classic hard rock.", "artists": ["Led Zeppelin", "Deep Purple"]},
    "80S Rock": {"description": "British 800 at full gain with a Greenbox overdrive pedal and a large hall.", "artists": ["Def Leppard", "Mötley Crüe"]},
    "90S Rock": {"description": "Rectifier at moderate gain, for fat palm-muted riffs.", "artists": ["Foo Fighters", "Soundgarden"]},
    "Super Live": {"description": "Super Sonic with plenty of gain, delay and a modulated hall, for hot, sizzling live tones.", "artists": ["Peter Frampton", "Thin Lizzy"]},
    "Boosted Brit": {"description": "British Plexi boosted by a Mythic Drive pedal, with tape delay.", "artists": ["Guns N' Roses", "AC/DC"]},
    "Pawn King": {"description": "Silvertone with a big fuzz pedal, for garage rock that sounds about to fall apart.", "artists": ["The Black Keys", "The White Stripes"]},
    "Angry Rodent": {"description": "Blackbox distortion pedal into a low-gain British 800, for thick, fuzzy alternative rock.", "artists": ["Pixies", "Radiohead"]},
    "Early Eddie": {"description": "British Plexi at full gain with phaser and EQ, for explosive, showy rock solos.", "artists": ["Van Halen"]},
    "Loud As Leeds": {"description": "British DR103 at full gain in a large hall, an aggressive amp pushed to its limit.", "artists": ["The Who"]},
    "Evil Bassman": {"description": "'59 Bassman boosted by a Blackbox distortion pedal, wild and raw.", "artists": ["Queens of the Stone Age"]}
  }},
  {"name": "Leads and metal", "presets": {
    "Stadium Lead": {"description": "Rectifier with chorus, delay and a large hall, for arena solos.", "artists": ["Journey", "Boston"]},
    "Metal 2000": {"description": "Modern 5150-style high gain, a heavy machine for tight metal riffs.", "artists": ["Trivium", "Machine Head"]},
    "BB15 Solo": {"description": "Bassbreaker 15 at high gain with tape delay and a large hall, for solos."},
    "Uber Metal": {"description": "Uberschall high-gain amp, for heavy modern metal.", "artists": ["Rammstein", "Metallica"]},
    "Octobot": {"description": "British 800 near full gain with an Octobot octave pedal, for thick leads.", "artists": ["Rage Against the Machine"]},
    "Fired Up Lead": {"description": "BE100 at full gain with mod delay and a large hall.", "artists": ["Joe Satriani"]},
    "Super Burn": {"description": "Super Sonic with overdrive, phaser and tape delay, for swirling metal leads.", "artists": ["Dokken"]},
    "Single Scoop": {"description": "5150-style high gain shaped by a five-band EQ, for scooped metal rhythm.", "artists": ["Metallica", "Pantera"]}
  }},
  {"name": "Echoes and space", "presets": {
    "Swirling Echoes": {"description": "Clean '65 Twin with compression, mod delay and a modulated hall.", "artists": ["Radiohead", "Coldplay"]},
    "Stereo Delay": {"description": "'57 Deluxe with a Mythic Drive pedal, mod delay and a large hall.", "artists": ["Pink Floyd", "John Mayer"]},
    "Wild Nocturne": {"description": "Crisp '65 Twin that seems to swirl around you, with compression, flanger, mod delay and a modulated hall.", "artists": ["The Cure", "Cocteau Twins"]},
    "Echo Dome": {"description": "Clean '65 Twin with compression, chorus, delay and spring reverb.", "artists": ["The Police", "U2"]},
    "Broken": {"description": "Bassbreaker 15 with a Mythic Drive pedal, reverse delay and a modulated hall.", "artists": ["Radiohead", "The Smashing Pumpkins"]},
    "Year 2290": {"description": "British AC30 with compression, mod delay and a modulated hall, for spacey parts.", "artists": ["Muse", "Queen"]},
    "Pigs Can Fly": {"description": "Big fuzz into a British DR103 with chorus, delay and a large hall, for rhythmic delay patterns.", "artists": ["Pink Floyd"]},
    "Irish Anthems": {"description": "British AC30 with compression, mod delay and a large hall, for ringing arena chords.", "artists": ["U2"]}
  }},
  {"name": "Chorus, tremolo and phaser", "presets": {
    "Hey Jimi": {"description": "Fuzz into a British Plexi with harmonic tremolo, tape delay and a large hall, for psychedelic rock.", "artists": ["Jimi Hendrix"]},
    "Twin Trem": {"description": "'65 Twin with tremolo and spring reverb, for a classic pulsing clean sound.", "artists": ["Tommy James and the Shondells", "The Smiths"]},
    "Vibra Drive": {"description": "'65 Twin with a Greenbox overdrive pedal, Vibratone and spring reverb.", "artists": ["Stevie Ray Vaughan"]},
    "Harmonic Vibrato": {"description": "British DR103 with a Mythic Drive pedal, harmonic tremolo and spring reverb.", "artists": ["John Mayer", "Brian Setzer"]},
    "Lavender Rain": {"description": "Clean '65 Twin with compression, chorus, delay and a large hall, for lush chords.", "artists": ["Prince"]},
    "Dirty Flanger": {"description": "British Plexi with a Greenbox overdrive pedal and flanger, for 70s hard rock.", "artists": ["Heart", "Van Halen"]},
    "Phased": {"description": "'65 Twin with compression, phaser and spring reverb.", "artists": ["Steely Dan"]},
    "Blk Hole Vibe": {"description": "'59 Bassman through a Vibratone in a large hall, for shimmering high arpeggios.", "artists": ["Soundgarden", "The Beatles"]},
    "Vintage Throb": {"description": "Low-gain British Plexi with a Mythic Drive pedal, tremolo, delay and a modulated hall.", "artists": ["Creedence Clearwater Revival"]},
    "Filtered Echoes": {"description": "'65 Twin with an envelope filter, delay and spring reverb, for funky vocal-like notes.", "artists": ["Grateful Dead", "Bootsy Collins"]}
  }},
  {"name": "Just the amp", "presets": {
    "65 Twin Reverb": {"description": "'65 Twin on its own, clean, with spring reverb.", "artists": ["The Beach Boys"]},
    "65 Dlx Reverb": {"description": "'65 Deluxe on its own, with spring reverb.", "artists": ["Wilco", "Tom Petty"]},
    "65 Princ Reverb": {"description": "'65 Princeton on its own, with spring reverb."},
    "57 Champ": {"description": "Tiny '57 Champ on its own, in a small room."},
    "57 Dlx Fat": {"description": "'57 Deluxe turned up for a fat tweed sound, in a small room.", "artists": ["Neil Young & Crazy Horse"]},
    "57 Twin": {"description": "'57 Twin at full gain on its own, in a large hall."},
    "Silver Tone": {"description": "Silvertone on its own, with spring reverb.", "artists": ["The White Stripes", "Beck"]},
    "Brit Colour": {"description": "British OR120 on its own in a large hall, thick and growling for sludgy riffs.", "artists": ["Sleep", "Electric Wizard"]},
    "Brit Stk Clean": {"description": "British DR103 on its own at moderate gain, in a large hall.", "artists": ["The Who", "Pink Floyd"]},
    "FBE100": {"description": "BE100 on its own, in a large hall.", "artists": ["Alice in Chains"]},
    "BB15 Low": {"description": "Bassbreaker 15 on its low-gain setting, in a small room."},
    "BB15 Mid": {"description": "Bassbreaker 15 on its medium-gain setting, in a small room."},
    "BB15 Hi": {"description": "Bassbreaker 15 on its high-gain setting, in a small room."},
    "Studio Pre": {"description": "Clean preamp with no amp character, in a large hall."}
  }}
];
