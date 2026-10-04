"""Adds subjects to tools/photo_catalog.json (idempotent: existing slugs are left alone).

Format per line:  name | more accepted answers ; half-credit answers | search query (optional)
The first name is the main answer. Run:  python tools/catalog_more.py
"""
import json, re
from pathlib import Path

CAT = Path(__file__).with_name("photo_catalog.json")

LISTS = {
"Animals": """
gorilla | silverback ; ape, monkey, animal
chimpanzee | chimp ; ape, monkey, animal
orangutan | orang utan ; ape, monkey, animal
kangaroo | ; marsupial, animal
hippopotamus | hippo ; animal
rhinoceros | rhino ; animal
polar bear | ; bear, animal
brown bear | grizzly bear, grizzly ; bear, animal
cheetah | ; big cat, cat, animal
leopard | ; big cat, cat, animal
jaguar | ; big cat, cat, animal
wolf | grey wolf, gray wolf ; dog, animal
deer | red deer, white-tailed deer ; animal
moose | elk ; deer, animal
camel | dromedary ; animal
llama | alpaca ; animal
sheep | lamb ; animal
goat | ; animal
pig | piglet, hog ; animal
donkey | ; horse, animal
rabbit | bunny, hare ; animal, pet
squirrel | ; rodent, animal
hedgehog | ; animal
raccoon | ; animal
beaver | ; rodent, animal
otter | sea otter ; animal
meerkat | ; animal
sloth | ; animal
armadillo | ; animal
bison | buffalo ; animal
crocodile | alligator ; reptile, animal
snake | python, boa ; reptile, animal
frog | tree frog ; amphibian, animal
iguana | ; lizard, reptile
tortoise | giant tortoise ; turtle, reptile
seal | harbor seal ; sea animal, animal
walrus | ; sea animal, animal
dalmatian | ; dog, puppy
german shepherd | alsatian ; dog
husky | siberian husky ; dog
poodle | ; dog
labrador | labrador retriever ; dog
bulldog | ; dog
corgi | ; dog
pug | ; dog
""",
"Birds": """
parrot | macaw ; bird
toucan | ; bird
hummingbird | ; bird
swan | ; bird
duck | mallard ; bird
goose | ; bird
pelican | ; bird
puffin | ; bird
ostrich | ; bird
penguin chick | ; penguin, bird
robin | european robin ; bird
woodpecker | ; bird
kingfisher | ; bird
rooster | chicken, cockerel ; bird
heron | ; bird
seagull | gull ; bird
""",
"Sea life": """
shark | great white shark ; fish
whale | humpback whale ; sea animal
jellyfish | ; sea animal
starfish | sea star ; sea animal
seahorse | sea horse ; fish
clownfish | ; fish
goldfish | ; fish
lobster | ; seafood, sea animal
stingray | ray ; fish
coral reef | coral ; reef, sea
""",
"Insects": """
beetle | stag beetle ; insect, bug
caterpillar | ; insect, bug
snail | ; animal
scorpion | ; bug
firefly | ; insect, bug
moth | ; insect, butterfly
wasp | hornet ; insect, bee
""",
"Famous places": """
white house | ; washington, building | White House Washington north facade
capitol building | us capitol, united states capitol ; washington, building | United States Capitol west front
empire state building | ; new york, skyscraper
times square | ; new york, city
central park | ; new york, park
chrysler building | ; new york, skyscraper
gateway arch | st louis arch ; arch, st louis
alamo | the alamo ; texas, mission | Alamo Mission San Antonio
yosemite | half dome, el capitan ; national park, mountain | Yosemite Valley Half Dome
devils tower | ; wyoming, rock
monument valley | ; desert, arizona, utah
delicate arch | arches national park ; arch, utah
mount everest | everest ; mountain, himalaya
louvre | louvre pyramid ; paris, museum | Louvre Pyramid Paris
notre dame | notre-dame de paris ; paris, cathedral | Notre-Dame de Paris facade
sacre coeur | sacre-coeur ; paris, church
mont saint michel | mont-saint-michel ; france, island
buckingham palace | ; london, palace
london eye | ; london, ferris wheel
st pauls cathedral | ; london, cathedral
edinburgh castle | ; scotland, castle
trevi fountain | ; rome, fountain
st peters basilica | ; rome, vatican, church
venice | grand canal ; italy, canal | Venice Grand Canal gondola
florence cathedral | duomo ; florence, cathedral
acropolis | parthenon ; athens, greece, temple
santorini | oia ; greece, island
brandenburg gate | ; berlin, gate
cologne cathedral | ; germany, cathedral
sagrada familia | ; barcelona, church
alhambra | ; spain, palace
red square | st basils cathedral ; moscow, russia | Saint Basil's Cathedral Moscow
kremlin | ; moscow, russia
hagia sophia | ; istanbul, mosque
blue mosque | sultan ahmed mosque ; istanbul, mosque
forbidden city | ; beijing, palace
tiananmen | ; beijing, gate
potala palace | ; tibet, palace
golden pavilion | kinkaku-ji ; kyoto, temple
tokyo tower | ; tokyo, tower
sphinx | great sphinx ; egypt, statue | Great Sphinx of Giza
abu simbel | ; egypt, temple
victoria falls | ; waterfall, africa
table mountain | ; cape town, mountain
kilimanjaro | mount kilimanjaro ; mountain, africa
uluru | ayers rock ; australia, rock
sydney harbour bridge | ; sydney, bridge
great barrier reef | ; reef, australia
iguazu falls | ; waterfall
easter island | moai ; statue, island
chichen itza | el castillo ; mexico, pyramid
golden temple | harmandir sahib ; india, temple
marina bay sands | ; singapore, hotel
petronas towers | ; kuala lumpur, skyscraper
cn tower | ; toronto, tower
""",
"Food": """
hamburger | burger, cheeseburger ; sandwich, food
hot dog | hotdog ; sausage, food
taco | tacos ; food
sushi | ; food, fish
spaghetti | pasta ; food
pancakes | pancake ; food, breakfast
waffle | waffles ; food, breakfast
croissant | ; bread, pastry
donut | doughnut ; dessert, food
ice cream | ice cream cone ; dessert
chocolate | ; candy, sweets
popcorn | ; snack, food
pretzel | ; bread, snack
bagel | ; bread
cheese | ; food
watermelon | ; fruit, melon
banana | bananas ; fruit
apple | apples ; fruit
orange | oranges ; fruit
lemon | lemons ; fruit
grapes | grape ; fruit
cherries | cherry ; fruit
blueberries | blueberry ; fruit, berry
coconut | ; fruit, nut
avocado | ; fruit, vegetable
broccoli | ; vegetable
carrot | carrots ; vegetable
corn | corn on the cob, maize ; vegetable
tomato | tomatoes ; vegetable, fruit
mushroom | mushrooms ; fungus, vegetable
pumpkin | ; vegetable, squash
eggs | egg ; food
coffee | cup of coffee, espresso ; drink
""",
"Objects": """
teddy bear | ; toy, bear
rubber duck | ; toy, duck
lego | lego bricks ; toy, bricks
kite | ; toy
chess | chessboard, chess pieces ; game, board game
dice | die ; game
playing cards | cards ; game
camera | ; device
telephone | rotary phone ; phone
radio | ; device
television | tv ; screen
laptop | ; computer
keyboard | computer keyboard ; computer
headphones | ; music
microphone | ; music
lamp | desk lamp ; light
light bulb | lightbulb ; light, lamp
candle | candles ; light
clock | wall clock ; time
hourglass | sand timer ; timer, clock
compass | ; tool
scissors | ; tool
hammer | ; tool
wrench | spanner ; tool
paintbrush | brush ; tool, art
pencil | pencils ; pen
book | books ; reading
globe | ; map, earth
backpack | rucksack ; bag
suitcase | luggage ; bag
key | keys ; lock
lock | padlock ; key
mailbox | letterbox, post box ; box
fire hydrant | hydrant ; street
traffic light | stoplight ; street, light
bench | park bench ; seat
ladder | ; tool
wheelbarrow | ; garden, cart
watering can | ; garden
anchor | ; ship, boat
""",
"Instruments and sport": """
drum | drums, drum kit ; instrument
trumpet | ; instrument, horn
saxophone | sax ; instrument
harp | ; instrument
accordion | ; instrument
banjo | ; instrument, guitar
cello | ; instrument, violin
xylophone | ; instrument
soccer ball | football ; ball
basketball | ; ball
baseball | baseball glove ; ball
tennis racket | tennis ; racket, sport
golf ball | golf ; ball, sport
bowling | bowling pins, bowling ball ; sport
skateboard | ; board
surfboard | surfing ; board
skis | skiing ; sport, snow
ice skates | ; skates, sport
boxing gloves | ; gloves, sport
""",
"Vehicles": """
motorcycle | motorbike ; vehicle, bike
scooter | vespa ; vehicle
school bus | ; bus, vehicle
double decker bus | double-decker ; bus, vehicle
taxi | cab ; car, vehicle
police car | ; car, vehicle
ambulance | ; vehicle
race car | formula one, f1 car ; car, vehicle
tank | ; vehicle, army
submarine | ; ship, boat
cruise ship | ; ship, boat
canoe | kayak ; boat
gondola | ; boat, venice
airplane | aeroplane, plane, jet ; aircraft
space shuttle | ; rocket, spacecraft
rocket | ; spacecraft
tram | streetcar, trolley ; train, vehicle
cable car | ; vehicle
bulldozer | ; vehicle, machine
excavator | digger ; vehicle, machine
""",
"Nature": """
waterfall | ; water, river
glacier | ; ice, mountain
iceberg | ; ice, sea
desert | sand dunes ; sand
beach | ; sea, sand
island | ; sea
lightning | ; storm, weather
tornado | ; storm, weather
aurora | northern lights, aurora borealis ; sky, lights
snowflake | ; snow, ice
autumn leaves | fall leaves ; leaves, tree
oak tree | oak ; tree
palm tree | ; tree
cherry blossom | sakura ; flower, tree
rose | roses ; flower
tulip | tulips ; flower
lotus | water lily ; flower
lavender | ; flower, plant
cave | ; rock
canyon | gorge ; valley, rock
moon | full moon ; space
""",
}

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

cat = json.loads(CAT.read_text(encoding="utf-8"))
have = {c["slug"] for c in cat}
added = 0
for category, block in LISTS.items():
    for line in block.strip().splitlines():
        parts = [p.strip() for p in line.split("|")]
        name = parts[0]
        acc_part, _, half_part = (parts[1] if len(parts) > 1 else "").partition(";")
        accepted = [name] + [a.strip() for a in acc_part.split(",") if a.strip()]
        partial = [a.strip() for a in half_part.split(",") if a.strip()]
        query = parts[2] if len(parts) > 2 and parts[2] else name
        s = slug(name)
        if s in have:
            continue
        cat.append({"slug": s, "cat": category, "q": query, "accepted": accepted, "partial": partial or ["thing"]})
        have.add(s); added += 1
CAT.write_text(json.dumps(cat, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"added {added}; catalog now {len(cat)}")
