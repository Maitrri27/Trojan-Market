const NAMES = ['Maya Rodriguez', 'Devin Park', 'Aisha Bello', 'Chris Nguyen', 'Priya Shah', 'Jordan Lee', 'Sam Ortiz', 'Ava Kim', 'Noah Patel', 'Lucia Marín', 'Eli Brooks', 'Hana Sato', 'Marcus Hall', 'Tessa Yang', 'Omar Haddad', 'Grace Liu', 'Diego Flores', 'Nina Kaur', 'Ryan Boyle', 'Zoe Alvarez'];

const RAW = {
  housing: [
    ['Sublease: 1BR at Icon Plaza, Aug–Dec', 1450, 'apartment', 'Icon Plaza', 'Furnished', 'Fully furnished 1BR in a 4-bed suite. Utilities and gym included, 8 min walk to Leavey. Lease transfer handled through the building office.'],
    ['Room near HSC with private bath', 1100, 'bedroom', 'HSC / Eastlake', 'Unfurnished', 'Quiet house share with two Keck students. Street parking, laundry in unit, 10 min on the HSC shuttle.'],
    ['Studio at The Lorenzo, spring only', 1725, 'apartment', 'The Lorenzo', 'Furnished', 'Spring semester takeover. Pool, gym and campus shuttle. Deposit already paid.'],
    ['Shared 2BR on 30th Street', 950, 'house', '30th Street', 'Partly furnished', 'Walking distance to the Row and campus. Roommate is a Viterbi junior. Utilities split three ways.'],
    ['Gateway Apartments, 1 of 2 rooms', 1290, 'balcony', 'Gateway Apartments', 'Furnished', 'Right across Figueroa. In-unit washer, doorman, 24/7 study lounge downstairs.'],
    ['Summer sublet in Cardinal Gardens', 780, 'apartment', 'Cardinal Gardens', 'Furnished', 'May through August. USC housing, so billing goes straight through the portal.'],
    ['Room in a house on Ellendale', 1025, 'bedroom', 'Ellendale Pl', 'Unfurnished', 'Big room with two windows, backyard, three grad students in the house. DPS patrol route.'],
    ['Parkside apartment spot, fall', 1180, 'dormitory', 'Parkside', 'Furnished', 'On-campus, meal plan optional, closest housing to Viterbi classes.'],
    ['2BR near USC Village, 12-mo lease', 2400, 'kitchen', 'USC Village area', 'Unfurnished', 'Whole unit for two people, remodeled kitchen, gated parking spot included.'],
    ['Vermont Ave loft, roommate wanted', 1150, 'loft', 'Vermont Ave', 'Furnished', 'High ceilings, exposed brick, walk to Expo line. Looking for a clean, quiet roommate.']
  ],
  furniture: [
    ['IKEA desk + chair, moving out', 0, 'desk', 'USC Village', 'Good', 'Free to a good home. Must pick up Saturday before 4pm — flying out Sunday.'],
    ['Twin XL mattress, barely used', 85, 'mattress', 'Fluor Tower', 'Like new', 'Used one semester with a protector the whole time. Fits all USC dorm beds.'],
    ['Grey two-seat couch', 140, 'sofa', '30th Street', 'Good', 'Comfortable, no stains, one small scuff on the back leg. You will need a truck.'],
    ['Standing desk, electric lift', 190, 'desk', 'Icon Plaza', 'Excellent', 'Dual motor, memory presets, quiet. Great for long problem sets.'],
    ['Bookshelf, 5 shelves', 45, 'bookshelf', 'Cardinal Gardens', 'Good', 'Solid pine, holds a full semester of textbooks. Easy to disassemble.'],
    ['Full-length mirror with stand', 30, 'mirror', 'The Lorenzo', 'Very good', 'No cracks or cloudiness. Leans or mounts on a wall.'],
    ['Desk lamp + LED strip set', 18, 'lamp', 'Birnkrant', 'Good', 'Warm and cool modes, USB port in the base. Strip has adhesive left.'],
    ['Nightstand, two drawers', 35, 'drawers', 'Parkside', 'Good', 'Matches most dorm furniture. Drawers slide clean.'],
    ['Rug 5x7, low pile', 55, 'rug', 'Gateway Apartments', 'Clean', 'Professionally cleaned last month. Makes a dorm floor bearable.'],
    ['Dining table + 2 chairs', 120, 'table', 'Ellendale Pl', 'Very good', 'Small footprint, perfect for a shared apartment kitchen.']
  ],
  electronics: [
    ['MacBook Air M1, 256GB', 520, 'macbook', 'Leavey Library', 'Excellent', 'Battery health 91%, no dents, charger and sleeve included. Upgrading for a design internship.'],
    ['iPad 9th gen + Apple Pencil', 285, 'ipad', 'Doheny Library', 'Very good', 'Best note-taking setup for lecture. Screen protector on since day one.'],
    ['27" 1440p monitor, 144Hz', 165, 'monitor', 'Ronald Tutor Hall', 'Like new', 'HDMI and DisplayPort cables included. No dead pixels.'],
    ['Sony WH-1000XM4 headphones', 175, 'headphones', 'USC Village', 'Good', 'Noise cancelling still excellent — a lifesaver during finals week in Leavey.'],
    ['Mechanical keyboard, hot-swap', 70, 'keyboard', 'Fluor Tower', 'Excellent', 'Brown switches, wired or 2.4G, extra keycaps in the box.'],
    ['Canon EOS M50 + 15-45mm', 380, 'camera', 'Annenberg', 'Very good', 'Great for Annenberg video assignments. Two batteries and a 64GB card.'],
    ['Anker 100W charger + cables', 32, 'charger', 'Trousdale Pkwy', 'Like new', 'Charges a laptop and phone at once. Two USB-C cables included.'],
    ['Logitech webcam 1080p', 28, 'webcam', 'Birnkrant', 'Good', 'Clean audio, clip mounts on any monitor. For hybrid classes.'],
    ['Bluetooth speaker, waterproof', 45, 'speaker', 'McCarthy Quad', 'Very good', 'Loud enough for the Row, survived a full year of pool days.'],
    ['Portable SSD 1TB, USB-C', 68, 'harddrive', 'Viterbi / RTH', 'Excellent', 'Fast enough to edit 4K straight off the drive. Barely used.']
  ],
  textbooks: [
    ['BUAD 304 + WRIT 150 bundle', 45, 'textbook', 'Tommy Trojan', 'Light highlighting', 'Both current editions. Access codes already used, books only.'],
    ['CSCI 104 data structures text', 38, 'books', 'Ronald Tutor Hall', 'Good', 'Some pencil notes in the graph chapters, otherwise clean.'],
    ['MATH 226 calculus, 9th ed', 42, 'mathematics', 'Kaprielian Hall', 'Very good', 'Spine intact, no writing. Includes the solutions supplement.'],
    ['CHEM 105 lab manual + goggles', 30, 'chemistry', 'Seeley Mudd', 'Used', 'Manual has blank pages left. Goggles washed and unscratched.'],
    ['ECON 203 principles text', 35, 'economics', 'Leavey Library', 'Good', 'Highlighting in the first three chapters only.'],
    ['BISC 220 biology bundle', 55, 'biology', 'HSC / Eastlake', 'Very good', 'Textbook plus study guide. Sold together only.'],
    ['PSYC 100 intro psychology', 28, 'psychology', 'Doheny Library', 'Good', 'Current edition, no missing pages.'],
    ['ITP 115 Python workbook', 22, 'python', 'Viterbi / RTH', 'Like new', 'Barely opened — I ended up using online notes.'],
    ['ACCT 410 with practice sets', 60, 'accounting', 'Marshall / JFF', 'Good', 'Practice sets unwritten. Big saver over the bookstore price.'],
    ['Communication theory reader', 25, 'library', 'Annenberg', 'Good', 'Annenberg course reader, current syllabus edition.']
  ],
  bikes: [
    ['Xiaomi scooter, 25mi range', 210, 'scooter', 'Parkside', 'Very good', 'Two years old, new tires in June. Folds for dorm storage. Helmet and cable lock included.'],
    ['Single-speed commuter bike', 130, 'bicycle', 'USC Village', 'Good', 'Light, fast across campus, freshly tuned at the bike co-op.'],
    ['Hybrid bike, 21-speed', 185, 'bicycle', 'Cardinal Gardens', 'Excellent', 'Handles the hills to HSC easily. New brake pads.'],
    ['Segway Ninebot F30', 260, 'scooter', 'Fluor Tower', 'Very good', 'App-locked, 18mph top speed, charger included.'],
    ['Folding bike for dorm rooms', 155, 'bicycle', 'Birnkrant', 'Good', 'Folds under a desk — no bike rack roulette.'],
    ['Mountain bike, front suspension', 175, 'mountainbike', 'Ellendale Pl', 'Good', 'Rides fine on campus and on trails on weekends.'],
    ['Kids-size road bike (adult small)', 95, 'bike', '30th Street', 'Fair', 'Good for riders under 5\'4". Needs new bar tape.'],
    ['U-lock + cable, Kryptonite', 25, 'padlock', 'Trousdale Pkwy', 'Like new', 'The lock DPS actually recommends. Two keys.'],
    ['Skateboard, cruiser deck', 48, 'skateboard', 'McCarthy Quad', 'Good', 'Smooth wheels for Trousdale. Grip tape still fresh.'],
    ['Helmet + front and rear lights', 20, 'helmet', 'Gateway Apartments', 'Very good', 'Required if you ride at night. Lights are USB rechargeable.']
  ],
  tickets: [
    ['2 tickets: USC vs UCLA, sec 208', 180, 'stadium', 'LA Coliseum', 'Digital transfer', 'Pair of seats on the aisle. Ticketmaster transfer within an hour of payment.'],
    ['Student section football ticket', 65, 'football', 'LA Coliseum', 'Digital transfer', 'One seat in the student section. Face value, no markup.'],
    ['Basketball vs Arizona, lower bowl', 55, 'basketball', 'Galen Center', 'Digital transfer', 'Great sightline behind the bench.'],
    ['Volleyball season pass, half', 40, 'volleyball', 'Galen Center', 'Digital transfer', 'Remaining home matches this semester.'],
    ['Springfest wristband', 45, 'concert', 'McCarthy Quad', 'Wristband', 'Cannot go anymore — meeting on campus to hand it over.'],
    ['Comedy night at Bovard, 2 seats', 30, 'theatre', 'Bovard Auditorium', 'Digital transfer', 'Row H center. Selling both together.'],
    ['LA Phil student night ticket', 22, 'orchestra', 'Downtown LA', 'Digital transfer', 'Walt Disney Concert Hall, student pricing already applied.'],
    ['Dodgers vs Giants, upper deck', 38, 'baseball', 'Dodger Stadium', 'Digital transfer', 'Two seats together, easy Metro ride from campus.'],
    ['Baseball vs Stanford, 4 seats', 48, 'baseball', 'Dedeaux Field', 'Digital transfer', 'Family bought too many. Selling all four as a set.'],
    ['Formal ticket, spring semester', 70, 'party', 'USC Village', 'Transfer', 'Includes bus and dinner. Name change is allowed until Friday.']
  ],
  services: [
    ['Calc tutoring, MATH 125/126', 30, 'studying', 'Doheny or online', 'Hourly', 'Math major, three semesters as a course grader. First 30 minutes free.'],
    ['Resume + LinkedIn review', 25, 'resume', 'Online', 'Per review', 'Marshall senior with recruiting experience. 48-hour turnaround.'],
    ['Headshots for LinkedIn', 60, 'portrait', 'USC Village', 'Per session', '30-minute shoot on campus, 8 edited photos delivered.'],
    ['Move-out help with a truck', 55, 'truck', 'Anywhere near UPC', 'Per trip', 'Pickup truck, two people, one hour of loading. Weekends only.'],
    ['CS 170 / 104 study coaching', 35, 'coding', 'RTH or online', 'Hourly', 'Not doing your homework — walking you through the concepts.'],
    ['Spanish conversation practice', 20, 'coffee', 'Leavey Library', 'Hourly', 'Native speaker, patient with beginners. Great before an exam.'],
    ['Haircuts in USC Village', 22, 'barber', 'USC Village', 'Per cut', 'Licensed, three years cutting. Fades and trims, cash or Venmo.'],
    ['Ride to LAX, shared', 25, 'airport', 'Campus pickup', 'Per seat', 'Breaks and holidays. Two bags per person, 3 seats available.'],
    ['Essay proofreading, WRIT 150', 18, 'writing', 'Online', 'Per essay', 'Grammar, structure and clarity. No ghostwriting.'],
    ['Guitar lessons for beginners', 28, 'guitar', 'Thornton area', 'Hourly', 'Thornton student. Bring your own guitar or use mine in the room.']
  ],
  free: [
    ['Free moving boxes + bubble wrap', 0, 'boxes', 'Cardinal Gardens', 'Used once', 'About 12 boxes in good shape. Take all or some.'],
    ['Free plants, need a new window', 0, 'plant', 'Icon Plaza', 'Healthy', 'Pothos and a snake plant. Pots included.'],
    ['Free textbooks, mixed GE courses', 0, 'books', 'Leavey Library', 'Used', 'Whatever is left after Friday goes to the library donation bin.'],
    ['Free mini shelf and hangers', 0, 'hangers', 'Fluor Tower', 'Good', 'Dorm closet leftovers. First to message gets it.'],
    ['Free desk chair, one wobbly wheel', 0, 'chair', 'Parkside', 'Fair', 'Honest listing: the wheel wobbles. Otherwise fine to sit in.'],
    ['Free kitchenware set', 0, 'kitchen', 'Ellendale Pl', 'Good', 'Two pans, plates, cutlery. Graduating and cannot ship it.'],
    ['Free full-length mirror', 0, 'mirror', 'The Lorenzo', 'Good', 'Small chip on the frame, glass is perfect.'],
    ['Free clothes, size M', 0, 'clothes', 'USC Village', 'Washed', 'Hoodies, tees and two jackets. Bring your own bag.'],
    ['Free printer, ink low', 0, 'printer', 'Birnkrant', 'Works', 'Prints fine. Cartridges are cheap online.'],
    ['Free futon, needs two people', 0, 'futon', '30th Street', 'Good', 'Free if you can carry it down one flight of stairs tonight.']
  ],
  other: [
    ['Mini fridge, dorm legal', 55, 'refrigerator', 'New North', 'Works great', 'Clean, cools fast, small freezer compartment. Pickup at the lobby.'],
    ['Microwave, 700W', 35, 'microwave', 'Fluor Tower', 'Good', 'Fits a dorm counter and passes housing rules.'],
    ['USC hoodie, cardinal, size L', 30, 'hoodie', 'USC Village', 'Like new', 'Official bookstore hoodie, worn twice.'],
    ['Air fryer, 4qt', 40, 'cooking', 'Gateway Apartments', 'Very good', 'The only appliance I actually used all year.'],
    ['Storage bins, set of 4', 20, 'boxes', 'Cardinal Gardens', 'Good', 'Stackable, fit under a dorm bed.'],
    ['Yoga mat + resistance bands', 18, 'yoga', 'Lyon Center', 'Clean', 'For Lyon Center classes or working out in your room.'],
    ['Electric kettle, 1.7L', 15, 'kettle', 'Birnkrant', 'Works', 'Boils fast, auto shutoff. Great for late-night ramen.'],
    ['Tennis racket + 3 balls', 32, 'tennis', 'Marks Tennis Stadium', 'Good', 'Strings still tight. Courts are free for students.'],
    ['Blender for smoothies', 25, 'blender', 'Parkside', 'Very good', 'Two travel cups included, easy to rinse.'],
    ['Suitcase, large hardshell', 45, 'suitcase', 'The Lorenzo', 'Good', 'One scuffed corner, all four wheels roll straight. Checked-bag size.']
  ]
};

const SEED = (function () {
  const out = []; let n = 0;
  Object.keys(RAW).forEach(function (cat) {
    RAW[cat].forEach(function (r, i) {
      const name = NAMES[n % NAMES.length];
      const parts = name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').split(' ');
      out.push({
        id: cat + '-' + (i + 1), title: r[0], category: cat, price: r[1], free: r[1] === 0,
        kw: r[2], location: r[3], condition: r[4], description: r[5],
        seller: name, email: parts[0].charAt(0) + parts[1].slice(0, 6) + '@usc.edu',
        days: (n * 3) % 14, views: 40 + ((n * 47) % 460), seed: n + 11
      });
      n++;
    });
  });
  return out;
})();

const CATKW = {"housing":"apartment","furniture":"furniture","electronics":"electronics","textbooks":"books","bikes":"bicycle","tickets":"stadium","services":"campus","free":"giveaway","movein":"bedding","other":"household"};


const HOODS = ['North University Park', 'USC Village', 'Adams-Normandie', 'Downtown / South Park', 'Exposition Park', 'HSC / Eastlake'];

const HOUSE = {
  'housing-1': { rent: 1450, beds: 1, baths: 1, hood: 'North University Park', commute: 8, pets: false, furnished: true, lease: 5, moveIn: 'Aug 15', type: 'Apartment', amenities: ['Gym', 'Utilities included', 'Pool'], gender: 'Any', food: 'Any' },
  'housing-2': { rent: 1100, beds: 1, baths: 1, hood: 'HSC / Eastlake', commute: 18, pets: true, furnished: false, lease: 12, moveIn: 'Sep 1', type: 'House share', amenities: ['Laundry in unit', 'Street parking'], gender: 'Female', food: 'Vegetarian-friendly' },
  'housing-3': { rent: 1725, beds: 1, baths: 1, hood: 'Downtown / South Park', commute: 16, pets: true, furnished: true, lease: 6, moveIn: 'Jan 5', type: 'Studio', amenities: ['Pool', 'Gym', 'Shuttle'], gender: 'Any', food: 'Any' },
  'housing-4': { rent: 950, beds: 2, baths: 1, hood: 'North University Park', commute: 10, pets: false, furnished: false, lease: 12, moveIn: 'Aug 20', type: 'Apartment', amenities: ['Backyard', 'Utilities split'], gender: 'Any', food: 'Any' },
  'housing-5': { rent: 1290, beds: 2, baths: 2, hood: 'USC Village', commute: 5, pets: false, furnished: true, lease: 12, moveIn: 'Aug 1', type: 'Apartment', amenities: ['Doorman', 'Washer/dryer', 'Study lounge'], gender: 'Male', food: 'Any' },
  'housing-6': { rent: 780, beds: 1, baths: 1, hood: 'USC Village', commute: 6, pets: false, furnished: true, lease: 4, moveIn: 'May 15', type: 'USC housing', amenities: ['On-campus billing', 'Furnished'], gender: 'Female', food: 'Vegetarian-friendly' },
  'housing-7': { rent: 1025, beds: 1, baths: 1, hood: 'Adams-Normandie', commute: 14, pets: true, furnished: false, lease: 12, moveIn: 'Sep 1', type: 'House share', amenities: ['Backyard', 'Grad students', 'DPS route'], gender: 'Any', food: 'Vegan-friendly' },
  'housing-8': { rent: 1180, beds: 1, baths: 1, hood: 'USC Village', commute: 4, pets: false, furnished: true, lease: 9, moveIn: 'Aug 22', type: 'USC housing', amenities: ['Meal plan option', 'Closest to Viterbi'], gender: 'Any', food: 'Any' },
  'housing-9': { rent: 2400, beds: 2, baths: 2, hood: 'USC Village', commute: 7, pets: true, furnished: false, lease: 12, moveIn: 'Aug 10', type: 'Apartment', amenities: ['Remodeled kitchen', 'Gated parking'], gender: 'Any', food: 'Halal-friendly' },
  'housing-10': { rent: 1150, beds: 1, baths: 1, hood: 'Exposition Park', commute: 12, pets: true, furnished: true, lease: 12, moveIn: 'Aug 25', type: 'Loft', amenities: ['High ceilings', 'Near Expo line'], gender: 'Any', food: 'Any' }
};

const ROOMMATES = [
  { id: 'r1', name: 'Alex Chen', email: 'achen@usc.edu', year: 'Junior · Viterbi', budget: [1100, 1500], hood: 'North University Park', clean: 4, noise: 2, sleep: 'early', smoking: false, pets: false, social: 3, lease: 12, moveIn: 'Aug 15', bio: 'CS junior, quiet weeknights, cook most meals. Looking for someone tidy and low-drama.' },
  { id: 'r2', name: 'Priya Nair', email: 'pnair@usc.edu', year: 'Grad · Marshall', budget: [1300, 1800], hood: 'Downtown / South Park', clean: 5, noise: 1, sleep: 'early', smoking: false, pets: false, social: 2, lease: 12, moveIn: 'Aug 1', bio: 'MBA student, gym at 6am, in bed by 11. Very clean, keep to myself on weeknights.' },
  { id: 'r3', name: 'Jordan Ellis', email: 'jellis@usc.edu', year: 'Senior · Annenberg', budget: [900, 1300], hood: 'North University Park', clean: 3, noise: 4, sleep: 'late', smoking: false, pets: true, social: 5, lease: 12, moveIn: 'Aug 20', bio: 'Film senior, edits late, hosts small dinners. Have a very calm cat named Trojan.' },
  { id: 'r4', name: 'Sofia Ramos', email: 'sramos@usc.edu', year: 'Sophomore · Dornsife', budget: [800, 1150], hood: 'USC Village', clean: 4, noise: 2, sleep: 'early', smoking: false, pets: false, social: 3, lease: 9, moveIn: 'Aug 22', bio: 'Pre-med, library person, quiet during finals. Happy to split groceries.' },
  { id: 'r5', name: 'Marcus Webb', email: 'mwebb@usc.edu', year: 'Junior · Thornton', budget: [1000, 1400], hood: 'Adams-Normandie', clean: 3, noise: 4, sleep: 'late', smoking: false, pets: false, social: 4, lease: 12, moveIn: 'Sep 1', bio: 'Music major — I practice with headphones after 9pm, promise. Social on weekends.' },
  { id: 'r6', name: 'Hana Ito', email: 'hito@usc.edu', year: 'Grad · Keck', budget: [1200, 1600], hood: 'HSC / Eastlake', clean: 5, noise: 1, sleep: 'early', smoking: false, pets: false, social: 2, lease: 12, moveIn: 'Jul 15', bio: 'Med student on rotations, unpredictable hours but extremely quiet and clean.' },
  { id: 'r7', name: 'Danny Okafor', email: 'dokafor@usc.edu', year: 'Senior · Viterbi', budget: [950, 1250], hood: 'North University Park', clean: 3, noise: 3, sleep: 'late', smoking: false, pets: true, social: 4, lease: 12, moveIn: 'Aug 15', bio: 'Robotics senior, lab until midnight. Dog-friendly, would love a place with a yard.' },
  { id: 'r8', name: 'Emily Zhao', email: 'ezhao@usc.edu', year: 'Junior · Marshall', budget: [1300, 1700], hood: 'USC Village', clean: 5, noise: 2, sleep: 'early', smoking: false, pets: false, social: 3, lease: 12, moveIn: 'Aug 10', bio: 'Accounting junior. Deep-clean every Sunday, split chores on a schedule.' },
  { id: 'r9', name: 'Tomás Rivera', email: 'trivera@usc.edu', year: 'Grad · Price', budget: [900, 1200], hood: 'Exposition Park', clean: 4, noise: 2, sleep: 'early', smoking: false, pets: false, social: 3, lease: 12, moveIn: 'Aug 25', bio: 'Policy grad, bike commuter, cook a lot. Looking for a calm apartment near Expo.' },
  { id: 'r10', name: 'Grace Kim', email: 'gkim@usc.edu', year: 'Sophomore · Roski', budget: [1000, 1400], hood: 'North University Park', clean: 4, noise: 3, sleep: 'late', smoking: false, pets: true, social: 4, lease: 9, moveIn: 'Aug 18', bio: 'Design student, studio nights, plants everywhere. Cat person.' },
  { id: 'r11', name: 'Ryan Patel', email: 'rpatel@usc.edu', year: 'Senior · Dornsife', budget: [1400, 1900], hood: 'Downtown / South Park', clean: 3, noise: 4, sleep: 'late', smoking: true, pets: false, social: 5, lease: 12, moveIn: 'Aug 1', bio: 'Econ senior, smoke on the balcony only. Very social, always have people over.' },
  { id: 'r12', name: 'Lauren Diaz', email: 'ldiaz@usc.edu', year: 'Grad · Rossier', budget: [1100, 1450], hood: 'USC Village', clean: 5, noise: 1, sleep: 'early', smoking: false, pets: false, social: 2, lease: 12, moveIn: 'Aug 12', bio: 'Teaching grad, up at 6, quiet home life. Prefer a roommate with a similar rhythm.' }
];

const BLANK_PROFILE = {
  budgetMin: 900, budgetMax: 1500, hood: 'North University Park', commuteMax: 15,
  clean: 4, noise: 2, sleep: 'early', smoking: false, pets: false, social: 3,
  lease: 12, moveIn: 'Aug 15', beds: 1, furnished: true
};


module.exports = { NAMES, RAW, SEED, CATKW, HOODS, HOUSE, ROOMMATES, BLANK_PROFILE };
